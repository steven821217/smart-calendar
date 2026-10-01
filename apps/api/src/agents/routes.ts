import type { FastifyInstance } from "fastify";
import { AgentTokenInput } from "@scal/shared";
import { enforce } from "../auth/pep.js";
import { signJwt } from "../auth/jwt.js";
import { listAgents, getAgent, revokeAgent, unrevokeAgent, isAgentRevoked } from "./service.js";
import { listAudit, writeAudit, type ActorType } from "../audit/service.js";

/**
 * Agent & MCP 管理端點（Admin，api.md 31-35 / frontend.md §9）。
 * 全部經 PEP → PDP(`agent.manage` / `audit.read`, 僅 admin) → RLS。跨 workspace 404。
 *
 * 例外：POST /v1/agents/tokens（綁定自己的 agent）允許任何登入使用者——發出的 token
 * 以呼叫者為 on-behalf-of、roles 沿用呼叫者，權限不可能超過他本人，故不需 admin。
 */
export function registerAgentRoutes(app: FastifyInstance) {
  // 31. 列已授權 agent
  app.get("/v1/agents", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "agent.manage", { type: "agent", workspace: auth.workspace })))
      return;
    return { agents: await listAgents(auth.workspace) };
  });

  // 32. agent 詳情
  app.get<{ Params: { id: string } }>("/v1/agents/:id", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "agent.manage", { type: "agent", workspace: auth.workspace })))
      return;
    const agent = await getAgent(auth.workspace, req.params.id);
    if (!agent) return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
    return agent;
  });

  // 33. 撤銷授權（即時生效，MCP-8）
  app.delete<{ Params: { id: string } }>("/v1/agents/:id/authorization", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "agent.manage", { type: "agent", workspace: auth.workspace })))
      return;
    await revokeAgent(auth.workspace, req.params.id);
    await writeAudit(auth.workspace, {
      actor_type: "user",
      action: "agent.revoke",
      target_type: "agent",
      agent_id: req.params.id,
      decision: "allow",
      metadata: { by: auth.sub },
    });
    return reply.code(204).send();
  });

  // 34. 該 agent 稽核動作（分頁）
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    "/v1/agents/:id/activity",
    async (req, reply) => {
      const auth = req.auth!;
      if (!(await enforce(req, reply, "agent.manage", { type: "agent", workspace: auth.workspace })))
        return;
      return listAudit(auth.workspace, {
        actor_type: "agent",
        agent_id: req.params.id,
        before: req.query.before,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
    },
  );

  // 35. MCP 活動時間軸（audit.read）
  app.get<{ Querystring: { actor_type?: string; before?: string; limit?: string } }>(
    "/v1/audit",
    async (req, reply) => {
      const auth = req.auth!;
      if (!(await enforce(req, reply, "audit.read", { type: "audit", workspace: auth.workspace })))
        return;
      return listAudit(auth.workspace, {
        actor_type: req.query.actor_type as ActorType | undefined,
        before: req.query.before,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
    },
  );

  // 36. 綁定自己的外部 agent：產生 scoped、可撤銷、有到期日的 bearer token（貼進 MCP 設定）。
  //     任何登入使用者皆可，因為 token 的能力上限就是他本人：
  //       sub=agent_id、user_sub=呼叫者（on-behalf-of）、roles=呼叫者 roles（不提權）、
  //       scope=使用者勾選的子集。撤銷走既有 DELETE /v1/agents/:id/authorization（即時）。
  app.post("/v1/agents/tokens", async (req, reply) => {
    const auth = req.auth!;
    // agent 自己不得再簽發 token（防 token 鏈式擴權/續命）
    if ((auth.scope?.length ?? 0) > 0 || auth.user_sub) {
      return reply
        .code(403)
        .send(problem(403, "forbidden", "agent token 不得用於簽發新的 agent token"));
    }
    const parsed = AgentTokenInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send(problem(422, "validation", parsed.error.message));
    }
    const { agent_id, scope, ttl_days } = parsed.data;

    // 已被撤銷的 agent 名稱不得靜默復活（否則任何成員都能繞過 admin 的撤銷決定）
    if (await isAgentRevoked(auth.workspace, agent_id)) {
      return reply
        .code(409)
        .send(
          problem(
            409,
            "conflict",
            `agent「${agent_id}」的授權已被撤銷；請改用其他名稱，或由 admin 解除撤銷後再產生。`,
          ),
        );
    }

    const ttlSec = ttl_days * 86_400;
    const access_token = signJwt(
      { sub: agent_id, workspace: auth.workspace, roles: auth.roles, scope, user_sub: auth.sub },
      ttlSec,
    );
    await writeAudit(auth.workspace, {
      actor_type: "user",
      action: "agent.token.issue",
      target_type: "agent",
      agent_id,
      on_behalf_of: auth.sub,
      decision: "allow",
      metadata: { by: auth.sub, scope, ttl_days },
    });
    reply.header("cache-control", "no-store"); // token 不得被快取
    return reply.code(201).send({
      access_token,
      token_type: "Bearer",
      expires_in: ttlSec,
      expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
      agent_id,
      scope,
      on_behalf_of: auth.sub,
    });
  });

  // 37. 解除撤銷（admin）：讓被撤銷的 agent 名稱可再次被綁定。
  app.post<{ Params: { id: string } }>("/v1/agents/:id/authorization", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "agent.manage", { type: "agent", workspace: auth.workspace })))
      return;
    await unrevokeAgent(auth.workspace, req.params.id);
    await writeAudit(auth.workspace, {
      actor_type: "user",
      action: "agent.unrevoke",
      target_type: "agent",
      agent_id: req.params.id,
      decision: "allow",
      metadata: { by: auth.sub },
    });
    return reply.code(204).send();
  });
}

function problem(status: number, title: string, detail?: string) {
  return { type: `https://api.example.com/errors/${title}`, title, status, detail };
}
