import type { FastifyInstance } from "fastify";
import { ReminderInput } from "@scal/shared";
import { enforce } from "../auth/pep.js";
import { getEvent } from "../events/service.js";
import { listReminders, createReminder, deleteReminder } from "./service.js";

function problem(status: number, title: string, detail?: string) {
  return { type: `https://api.example.com/errors/${title}`, title, status, detail };
}

/**
 * 事件提醒端點（api.md 26-28，REQ-4 / REM-*）。
 * 列表用 event.read、設/移除用 event.update（PEP → PDP → Service → RLS）。
 * 事件不存在或跨 workspace → 404（不洩漏存在性）。
 */
export function registerReminderRoutes(app: FastifyInstance) {
  // 26. GET /v1/events/:id/reminders — 列提醒
  app.get<{ Params: { id: string } }>("/v1/events/:id/reminders", async (req, reply) => {
    const auth = req.auth!;
    const ev = await getEvent(auth.workspace, req.params.id);
    if (!ev) return reply.code(404).send(problem(404, "not-found"));
    if (!(await enforce(req, reply, "event.read", {
      type: "event", workspace: auth.workspace, owner_id: ev.created_by, visibility: ev.visibility,
    }))) return;
    return { reminders: await listReminders(auth.workspace, req.params.id) };
  });

  // 27. POST /v1/events/:id/reminders — 設會前 N 分提醒
  app.post<{ Params: { id: string } }>("/v1/events/:id/reminders", async (req, reply) => {
    const auth = req.auth!;
    const parsed = ReminderInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send(problem(422, "validation", parsed.error.message));
    }
    const ev = await getEvent(auth.workspace, req.params.id);
    if (!ev) return reply.code(404).send(problem(404, "not-found"));
    if (!(await enforce(req, reply, "event.update", {
      type: "event", workspace: auth.workspace, owner_id: ev.created_by, visibility: ev.visibility,
    }))) return;
    const created = await createReminder(auth.workspace, req.params.id, {
      lead_minutes: parsed.data.lead_minutes,
      member_id: parsed.data.member_id,
      channel: parsed.data.channel,
    });
    if (!created) return reply.code(404).send(problem(404, "not-found"));
    return reply.code(201).send(created.reminder);
  });

  // 28. DELETE /v1/events/:id/reminders/:rid — 移除提醒
  app.delete<{ Params: { id: string; rid: string } }>(
    "/v1/events/:id/reminders/:rid",
    async (req, reply) => {
      const auth = req.auth!;
      const ev = await getEvent(auth.workspace, req.params.id);
      if (!ev) return reply.code(404).send(problem(404, "not-found"));
      if (!(await enforce(req, reply, "event.update", {
        type: "event", workspace: auth.workspace, owner_id: ev.created_by, visibility: ev.visibility,
      }))) return;
      const removed = await deleteReminder(auth.workspace, req.params.id, req.params.rid);
      if (!removed) return reply.code(404).send(problem(404, "not-found"));
      return reply.code(204).send();
    },
  );
}
