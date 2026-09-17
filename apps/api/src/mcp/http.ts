/**
 * MCP Server（Streamable HTTP）— 對外傳輸（mcp.md §6/§7，8.8）。
 *
 * 定位（對齊 spec）：
 *  - 對外 agent 走 Streamable HTTP，每個請求帶 `Authorization: Bearer <JWT>`（MCP-7）。
 *  - 本 service **不直接對公網**（MCP-10）：預設繫結 127.0.0.1，正式部署在其前方擺
 *    gateway（TLS + rate-limit + token 驗證）反向代理。此檔只負責 MCP 協定與
 *    per-request 授權，TLS/限流交給 gateway。
 *  - OAuth 2.1 consent 授權伺服器（發 M2M token）列為未實作（mcp.md §3 / 8.3）；
 *    此處假設 token 已由既有 signJwt 簽發（本機以 /debug 端點或 REST /v1/auth 取得）。
 *
 * 零信任（每次請求）：
 *  - Authorization header → verifyJwt → AuthContext；缺/失效 → 401（協定層），
 *    tool 層再經 guardTool 做 scope∩role + PDP + 撤銷檢查（MCP-2/9）。
 *  - workspace/sub 僅來自 token；tool 參數不得帶 workspace_id（ZT-5）。
 *
 * 傳輸模式：stateful（sessionIdGenerator=randomUUID）。每個 MCP session 綁定
 * 初始化當下解析出的 AuthContext（該 agent 的 token）。
 *
 * 執行：MCP_HTTP_PORT=3001 tsx src/mcp/http.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { verifyJwt, type AuthContext } from "../auth/jwt.js";
import { buildMcpServer } from "./server.js";

const MCP_PATH = "/mcp";
const SESSION_HEADER = "mcp-session-id";

interface Session {
  transport: StreamableHTTPServerTransport;
  auth: AuthContext | null;
}

const sessions = new Map<string, Session>();

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

/** JSON-RPC 風格錯誤（協定層），對齊 SDK 慣例。 */
function rpcError(res: ServerResponse, status: number, code: number, message: string) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

/**
 * 處理 /mcp 請求。stateful：
 *  - POST + initialize（無 session）：驗 Authorization → 建新 session（綁該 auth）。
 *  - POST/GET/DELETE + 既有 session id：轉交該 session 的 transport。
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers[SESSION_HEADER] as string | undefined;

  // 既有 session：直接轉交
  if (sessionId && sessions.has(sessionId)) {
    const s = sessions.get(sessionId)!;
    const body = req.method === "POST" ? await readBody(req).catch(() => undefined) : undefined;
    await s.transport.handleRequest(req, res, body);
    return;
  }

  // 新 session 只允許 POST initialize
  if (req.method !== "POST") {
    return rpcError(res, 400, -32000, "missing or invalid mcp-session-id");
  }

  const body = await readBody(req).catch(() => undefined);
  if (!isInitializeRequest(body)) {
    return rpcError(res, 400, -32000, "expected initialize request to open a session");
  }

  // 對外授權（MCP-7）：initialize 必須帶有效 Bearer token
  const auth = verifyJwt(req.headers.authorization);
  if (!auth) {
    return rpcError(res, 401, -32001, "unauthorized: missing or invalid Bearer token");
  }

  // 為此 session 建立綁定該 auth 的 MCP server 實例
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid: string) => {
      sessions.set(sid, { transport, auth });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  const server = buildMcpServer(auth);
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function buildHttpServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        return sendJson(res, 200, { status: "ok", sessions: sessions.size });
      }
      if (url.pathname === MCP_PATH) {
        return await handleMcp(req, res);
      }
      rpcError(res, 404, -32601, "not found");
    } catch (e) {
      rpcError(res, 500, -32603, e instanceof Error ? e.message : "internal error");
    }
  });
}

export async function main() {
  const port = Number(process.env.MCP_HTTP_PORT ?? 3001);
  // MCP-10：不直接對公網，預設繫結 loopback；gateway 在前方反代並處理 TLS/限流。
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const server = buildHttpServer();
  server.listen(port, host, () => {
    process.stderr.write(
      `[mcp-http] scal-calendar-mcp Streamable HTTP on http://${host}:${port}${MCP_PATH} ` +
        `(behind gateway; Bearer required)\n`,
    );
  });
}

if (process.argv[1] && /mcp[\\/]http\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    process.stderr.write(`[mcp-http] fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
}
