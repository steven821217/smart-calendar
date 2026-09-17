import type { FastifyInstance } from "fastify";
import { WebhookInput } from "@scal/shared";
import { enforce } from "../auth/pep.js";
import { createWebhook, listWebhooks, deleteWebhook } from "./service.js";
import { writeAudit } from "../audit/service.js";

/**
 * Webhook 管理端點（api.md 29，REQ-N3）。全部經 webhook.manage（admin）→ RLS。
 */
export function registerWebhookRoutes(app: FastifyInstance) {
  // 29a. GET /v1/webhooks
  app.get("/v1/webhooks", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "webhook.manage", { type: "webhook", workspace: auth.workspace })))
      return;
    return { webhooks: await listWebhooks(auth.workspace) };
  });

  // 29b. POST /v1/webhooks
  app.post("/v1/webhooks", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "webhook.manage", { type: "webhook", workspace: auth.workspace })))
      return;
    const parsed = WebhookInput.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(422)
        .send({ type: "…/validation", title: "Unprocessable", status: 422, detail: parsed.error.message });
    }
    const wh = await createWebhook(auth.workspace, parsed.data);
    await writeAudit(auth.workspace, {
      actor_type: "user", actor_id: null, on_behalf_of: auth.sub, action: "webhook.create",
      target_type: "webhook", target_id: wh.id, decision: "allow",
      metadata: { url: wh.url, events: wh.events },
    });
    return reply.code(201).send(wh);
  });

  // 29c. DELETE /v1/webhooks/:id
  app.delete<{ Params: { id: string } }>("/v1/webhooks/:id", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "webhook.manage", { type: "webhook", workspace: auth.workspace })))
      return;
    const ok = await deleteWebhook(auth.workspace, req.params.id);
    if (!ok) return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
    await writeAudit(auth.workspace, {
      actor_type: "user", actor_id: null, on_behalf_of: auth.sub, action: "webhook.delete",
      target_type: "webhook", target_id: req.params.id, decision: "allow",
    });
    return reply.code(204).send();
  });
}
