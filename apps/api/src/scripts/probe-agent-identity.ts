/**
 * 外部 agent 身分驗證 probe：跑真實 OAuth 2.1 consent（PKCE）→ 換 M2M token →
 * 經 gateway 呼叫 MCP Streamable HTTP 的 query_calendar → 檢查 token claims 與稽核紀錄。
 *
 * 回答的問題：外部 agent 是「以誰的身分」操作日曆？它自己能不能知道？
 *
 * 執行（host）：
 *   pnpm --filter @scal/api exec tsx src/scripts/probe-agent-identity.ts
 */
import crypto from "node:crypto";
import pg from "pg";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const BASE = process.env.PROBE_BASE ?? "https://127.0.0.1:9443";
const AGENT_ID = process.env.PROBE_AGENT_ID ?? "identity-probe-agent";

const b64url = (b: Buffer) => b.toString("base64url");

const postJson = async <T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
};

interface LoginResp { access_token: string; me: { email: string; membership_id: string } }
interface ConsentResp { authorization_code?: string; code?: string; expires_in?: number }
interface TokenResp { access_token?: string; scope?: string }

async function main() {
  // 1) 使用者登入（人類）
  const login = await postJson<LoginResp>(`${BASE}/v1/auth/login`, {
    email: "a@example.com",
    password: process.env.SEED_DEMO_PASSWORD ?? "demo-password-1234",
  });
  const userJwt = login.access_token;
  console.log("使用者登入：", login.me.email, "membership =", login.me.membership_id);

  // 2) 使用者授權該 agent（consent + PKCE）
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const consent = await postJson<ConsentResp>(
    `${BASE}/v1/oauth/consent`,
    {
      agent_id: AGENT_ID,
      scope: ["availability.read"],
      code_challenge: challenge,
      code_challenge_method: "S256",
    },
    { authorization: `Bearer ${userJwt}` },
  );
  console.log("consent →", Object.keys(consent).join(","));

  // 3) agent 用 code 換 token
  const tok = await postJson<TokenResp>(`${BASE}/v1/oauth/token`, {
    grant_type: "authorization_code",
    code: consent.authorization_code ?? consent.code,
    code_verifier: verifier,
    agent_id: AGENT_ID,
  });
  const agentToken = tok.access_token;
  if (!agentToken) {
    console.error("換 token 失敗：", tok);
    process.exit(1);
  }

  // 4) agent 能從自己的 token 讀到什麼身分資訊？（JWT 未加密，agent 可自行解碼）
  const claims = JSON.parse(Buffer.from(agentToken.split(".")[1], "base64").toString("utf8"));
  console.log("\n== agent 手上 token 的 claims ==");
  console.log(JSON.stringify(claims, null, 2));

  // 5) agent 拿這個 token 打 /v1/auth/me（想問「我是誰」）
  const me = await fetch(`${BASE}/v1/auth/me`, { headers: { authorization: `Bearer ${agentToken}` } });
  console.log(`\nagent 打 /v1/auth/me → HTTP ${me.status}`, (await me.text()).slice(0, 160));

  // 6) agent 經 MCP 呼叫 whoami / query_calendar（Streamable HTTP：initialize → tools/call）
  interface RpcOut { sid?: string; status: number; json: Record<string, unknown> }
  const rpc = async (body: unknown, sid?: string): Promise<RpcOut> => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sid ? { "mcp-session-id": sid } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    // Streamable HTTP 可能回 SSE 格式，取出 data: 行
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    let json: Record<string, unknown>;
    if (line) json = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
    else {
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text }; }
    }
    return { sid: res.headers.get("mcp-session-id") ?? sid, status: res.status, json };
  };

  const toolText = (out: RpcOut): string => {
    const result = out.json.result as { content?: Array<{ text?: string }> } | undefined;
    return result?.content?.[0]?.text ?? JSON.stringify(out.json);
  };

  const init = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "identity-probe", version: "0" } },
  });
  console.log(`\nMCP initialize → HTTP ${init.status}, session=${init.sid ? "ok" : "none"}`);
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, init.sid);

  // agent 問「我是誰、代表誰」
  const who = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } }, init.sid);
  console.log("\n== whoami ==");
  console.log(toolText(who));

  const call = await rpc({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "query_calendar", arguments: { question: "明天有哪些行程", viewer_timezone: "Asia/Taipei" } },
  }, init.sid);
  console.log("\nquery_calendar →", toolText(call).slice(0, 220));

  // 7) 稽核紀錄：這次 agent 操作被記成誰？
  const admin = new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD}@127.0.0.1:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
  await admin.connect();
  try {
    const r = await admin.query(
      `SELECT actor_type, agent_id, on_behalf_of, action, decision, at
         FROM audit_log
        WHERE agent_id = $1
        ORDER BY at DESC LIMIT 5`,
      [AGENT_ID],
    );
    console.log(`\n== audit_log（agent_id=${AGENT_ID}）==`);
    console.log(r.rowCount ? r.rows : "(沒有任何稽核紀錄！)");
    console.log("\n授權者 membership（應等於 on_behalf_of）:", login.me.membership_id);
  } finally {
    await admin.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
