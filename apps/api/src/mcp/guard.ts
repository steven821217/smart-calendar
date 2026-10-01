import type { AuthContext } from "../auth/jwt.js";
import { authorize, type AuthzResource } from "../auth/pdp.js";
import { isAgentRevoked } from "../agents/service.js";
import { writeAudit } from "../audit/service.js";

export class McpAuthError extends Error {
  constructor(
    public kind: "unauthorized" | "insufficient_scope" | "forbidden" | "not_found",
    msg: string,
  ) {
    super(msg);
    this.name = "McpAuthError";
  }
}

// tool → 需要的 OAuth scope（MCP-9）
export const TOOL_SCOPE: Record<string, string> = {
  find_available_time_slots: "availability.read",
  list_event_occurrences: "availability.read",
  query_calendar: "availability.read",
  create_smart_event: "event.write",
  update_event_occurrence: "event.write",
  resolve_scheduling_conflict: "event.write",
  parse_event_from_text: "event.write",
  book_resource: "resource.book",
  delegate_complex_scheduling: "event.write",
};

/**
 * 零信任守門（ZT-2/4/5，MCP-2/9）：每次 tool call 都
 *  1. 確認 token 有效（auth 非 null）
 *  2. scope 檢查：tool ∈ token.scope
 *  3. PEP→PDP authorize 重新求值（agent 權限 = scope ∩ role）
 * workspace/sub 僅來自 token（不從 tool 參數，ZT-5）。
 */
export async function guardTool(
  auth: AuthContext | null,
  tool: string,
  action: string,
  resource: Omit<AuthzResource, "workspace">,
): Promise<AuthContext> {
  if (!auth) throw new McpAuthError("unauthorized", "invalid or missing token");

  const needed = TOOL_SCOPE[tool];
  if (needed && !(auth.scope ?? []).includes(needed)) {
    throw new McpAuthError("insufficient_scope", `tool ${tool} requires scope ${needed}`);
  }

  // 撤銷檢查（MCP-8）：被列入黑名單的 agent 立即 fail-closed
  const isAgent = (auth.scope?.length ?? 0) > 0;
  if (isAgent && (await isAgentRevoked(auth.workspace, auth.sub))) {
    await auditAgent(auth, tool, action, resource, "deny", "revoked");
    throw new McpAuthError("forbidden", "agent authorization revoked");
  }

  // resource.workspace 一律來自 token（ZT-5），tool 參數不得覆寫
  const decision = await authorize({
    subject: auth,
    action,
    resource: { ...resource, workspace: auth.workspace },
  });
  if (!decision.allow) {
    await auditAgent(auth, tool, action, resource, "deny", decision.reason);
    // 跨 workspace 對外表現為 not_found（不洩漏存在性）
    throw new McpAuthError("forbidden", decision.reason ?? "denied");
  }
  await auditAgent(auth, tool, action, resource, "allow");
  return auth;
}

/** audit_log.on_behalf_of 是 uuid 欄位；非 uuid（如 OAuth token 的 agent_id）一律寫 null。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(v?: string | null): string | null {
  return v && UUID_RE.test(v) ? v : null;
}

/** 每次 MCP tool 呼叫寫稽核（MCP-13）：actor_type=agent, agent_id, on_behalf_of。 */
async function auditAgent(
  auth: AuthContext,
  tool: string,
  action: string,
  resource: Omit<AuthzResource, "workspace">,
  decision: "allow" | "deny",
  reason?: string,
) {
  try {
    await writeAudit(auth.workspace, {
      actor_type: "agent",
      agent_id: auth.sub,
      // on_behalf_of = 授權該 agent 的「人」（OAuth consent 記下的 user_sub）。
      // 舊實作寫 auth.sub：對 OAuth 發出的 M2M token 而言那是 agent_id（文字字串），
      // 塞進 uuid 欄位會拋 22P02 並被 catch 吞掉 → MCP tool 呼叫**完全沒有稽核紀錄**。
      // dev 自簽 token（sub 本身就是 membership uuid、無 user_sub）行為不變。
      on_behalf_of: uuidOrNull(auth.user_sub ?? auth.sub),
      action,
      target_type: resource.type,
      decision,
      metadata: { tool, scope: auth.scope ?? [], ...(reason ? { reason } : {}) },
    });
  } catch (e) {
    // 稽核寫入失敗不應阻斷授權判斷本身；但也不該靜默消失（否則零信任稽核形同不存在）。
    process.stderr.write(
      `[mcp-audit] WARNING: failed to write audit (tool=${tool}, agent=${auth.sub}): ` +
        `${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}
