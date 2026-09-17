import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enforce } from "../auth/pep.js";
import {
  listGroups,
  createGroup,
  deleteGroup,
  listGroupMembers,
  addGroupMember,
  removeGroupMember,
  listWorkspaceMembers,
} from "./service.js";

const CreateGroupInput = z.object({ name: z.string().min(1).max(200) });
const AddMemberInput = z.object({
  user_id: z.string().uuid(),
  role: z.enum(["leader", "member"]).default("member"),
});

function problem(status: number, title: string, detail?: string) {
  return { type: `https://api.example.com/errors/${title}`, title, status, detail };
}

/**
 * 團隊群組 REST（feature-team-groups）。
 * - 讀取（group.read）：本 workspace 成員。
 * - 管理（group.manage）：admin / scheduler。
 * PEP → OPA 重新求值；workspace 脈絡僅來自 token。
 */
export function registerGroupRoutes(app: FastifyInstance) {
  // 列本 workspace 成員（供群組成員挑選器）。group.read（本 workspace 成員可讀）。
  app.get("/v1/members", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "group.read", { type: "group", workspace: auth.workspace }))) return;
    const members = await listWorkspaceMembers(auth.workspace);
    return { members };
  });

  // 列群組
  app.get("/v1/groups", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "group.read", { type: "group", workspace: auth.workspace }))) return;
    const groups = await listGroups(auth.workspace);
    return { groups };
  });

  // 建群組
  app.post("/v1/groups", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "group.manage", { type: "group", workspace: auth.workspace }))) return;
    const parsed = CreateGroupInput.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send(problem(422, "Unprocessable", parsed.error.message));
    try {
      const g = await createGroup(auth.workspace, parsed.data.name, auth.sub);
      return reply.code(201).send(g);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = /unique|duplicate/i.test(msg) ? 409 : 422;
      return reply.code(code).send(problem(code, code === 409 ? "Conflict" : "Unprocessable", msg));
    }
  });

  // 刪群組
  app.delete<{ Params: { id: string } }>("/v1/groups/:id", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "group.manage", { type: "group", workspace: auth.workspace }))) return;
    const removed = await deleteGroup(auth.workspace, req.params.id);
    if (!removed) return reply.code(404).send(problem(404, "not-found"));
    return reply.code(204).send();
  });

  // 列群組成員
  app.get<{ Params: { id: string } }>("/v1/groups/:id/members", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "group.read", { type: "group", workspace: auth.workspace }))) return;
    const members = await listGroupMembers(auth.workspace, req.params.id);
    return { members };
  });

  // 加成員
  app.post<{ Params: { id: string } }>("/v1/groups/:id/members", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "group.manage", { type: "group", workspace: auth.workspace }))) return;
    const parsed = AddMemberInput.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send(problem(422, "Unprocessable", parsed.error.message));
    try {
      const m = await addGroupMember(auth.workspace, req.params.id, parsed.data.user_id, parsed.data.role);
      return reply.code(201).send(m);
    } catch (e: unknown) {
      return reply.code(422).send(problem(422, "Unprocessable", e instanceof Error ? e.message : String(e)));
    }
  });

  // 移除成員
  app.delete<{ Params: { id: string; userId: string } }>(
    "/v1/groups/:id/members/:userId",
    async (req, reply) => {
      const auth = req.auth!;
      if (!(await enforce(req, reply, "group.manage", { type: "group", workspace: auth.workspace }))) return;
      const removed = await removeGroupMember(auth.workspace, req.params.id, req.params.userId);
      if (!removed) return reply.code(404).send(problem(404, "not-found"));
      return reply.code(204).send();
    },
  );
}
