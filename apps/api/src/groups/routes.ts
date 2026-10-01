import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nonBlankText } from "@scal/shared";
import { enforce } from "../auth/pep.js";
import { writeAudit } from "../audit/service.js";
import {
  listGroups,
  createGroup,
  deleteGroup,
  listGroupMembers,
  addGroupMember,
  removeGroupMember,
  listWorkspaceMembers,
  addWorkspaceMemberByEmail,
  findWorkspaceMemberByEmail,
} from "./service.js";

const CreateGroupInput = z.object({ name: nonBlankText(200, "群組名稱") });
const AddMemberInput = z.object({
  user_id: z.string().uuid(),
  role: z.enum(["leader", "member"]).default("member"),
});
/** 加入工作區成員：以 email 指名「已註冊」的使用者（不寄邀請信）。 */
const AddWorkspaceMemberInput = z.object({
  email: z.string().email().max(320),
  role: z.enum(["admin", "scheduler", "member"]).default("member"),
  timezone: z.string().min(1).max(64).optional(),
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

  // 依 email 找本 workspace 的成員（邀請與會者時用 email 找人）。
  // 只查本 workspace：避免變成「某 email 是否在本平台註冊過」的列舉面。
  app.get<{ Querystring: { email?: string } }>("/v1/members/by-email", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "group.read", { type: "group", workspace: auth.workspace }))) return;
    const email = (req.query.email ?? "").trim();
    if (!email) {
      return reply.code(422).send({
        type: "…/validation", title: "email required", status: 422, detail: "請提供 email。",
      });
    }
    const member = await findWorkspaceMemberByEmail(auth.workspace, email);
    if (!member) {
      return reply.code(404).send({
        type: "…/not-found", title: "Not Found", status: 404,
        detail: "這個 email 不在本工作區的成員名單中。請先到「團隊群組」頁把他加入工作區（對方需已用此 email 註冊）。",
      });
    }
    return { member };
  });

  // 加入工作區成員（admin）：對方必須**先自己註冊**，這裡用 email 把他加進本 workspace。
  // action=member.manage：Rego 沒有明列此 action，故僅 admin 能過（admin 對本 workspace 全權，
  // 其餘角色 deny-by-default）——不需改政策即達成「只有 admin 能加人」。
  app.post("/v1/members", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "member.manage", { type: "member", workspace: auth.workspace })))
      return;
    const parsed = AddWorkspaceMemberInput.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send(problem(422, "Unprocessable", parsed.error.message));
    const email = parsed.data.email.trim().toLowerCase();
    const r = await addWorkspaceMemberByEmail(auth.workspace, email, parsed.data.role, parsed.data.timezone);
    if (r.kind === "not_registered") {
      return reply
        .code(404)
        .send(
          problem(
            404,
            "not-found",
            "查不到這個電子郵件的帳號。請對方先自行到本站註冊，再回來加入。",
          ),
        );
    }
    if (r.kind === "already_member") {
      return reply.code(409).send(problem(409, "Conflict", "這個人已經是本工作區的成員。"));
    }
    await writeAudit(auth.workspace, {
      actor_type: "user",
      action: "member.add",
      target_type: "member",
      target_id: r.member.membership_id,
      decision: "allow",
      on_behalf_of: auth.sub,
      metadata: { by: auth.sub, email, role: parsed.data.role },
    });
    return reply.code(201).send(r.member);
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
