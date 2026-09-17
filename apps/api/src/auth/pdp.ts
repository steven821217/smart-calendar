import type { AuthContext } from "./jwt.js";

export interface AuthzResource {
  type: string;
  id?: string;
  workspace: string;
  owner_id?: string;
  visibility?: string;
}

export interface AuthzInput {
  subject: AuthContext;
  action: string;
  resource: AuthzResource;
  context?: Record<string, unknown>;
}

export interface Decision {
  allow: boolean;
  reason?: string;
}

const OPA_URL = process.env.OPA_URL ?? "http://localhost:8181";

/**
 * PEP → PDP：每次請求重新向 OPA 求值（不快取決策，PEP-3）。
 * subject 來自已驗證 JWT；resource/action 由路由決定（PEP-2）。
 */
export async function authorize(input: AuthzInput): Promise<Decision> {
  const res = await fetch(`${OPA_URL}/v1/data/calendar/authz/allow`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) {
    // PDP 不可用時 fail-closed（拒絕），不放行
    return { allow: false, reason: `pdp_unavailable_${res.status}` };
  }
  const data = (await res.json()) as { result?: boolean };
  return { allow: data.result === true };
}
