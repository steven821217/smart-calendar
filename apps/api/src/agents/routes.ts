import type { FastifyInstance } from "fastify";
import { enforce } from "../auth/pep.js";
import { listAgents, getAgent, revokeAgent } from "./service.js";
import { listAudit, writeAudit, type ActorType } from "../audit/service.js";

/**
 * Agent & MCP 管理端點（Admin，api.md 31-35 / frontend.md §9）。
 * 全部經 PEP → PDP(`agent.manage` / `audit.read`, 僅 admin) → RLS。跨 workspace 404。
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
}
