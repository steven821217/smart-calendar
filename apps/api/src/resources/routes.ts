import type { FastifyInstance } from "fastify";
import { ResourceInput, BookingInput } from "@scal/shared";
import { enforce } from "../auth/pep.js";
import { writeAudit } from "../audit/service.js";
import {
  listResources,
  createResource,
  bookResource,
  cancelBooking,
  BookingConflictError,
} from "./service.js";

function problem(status: number, title: string, detail?: string) {
  return { type: `https://api.example.com/errors/${title}`, title, status, detail };
}

/**
 * 資源端點（api.md 22-25，REQ-R1/R2）。
 * 全部經 PEP → PDP → Service → RLS。預訂防雙訂由 DB EXCLUDE 兜底（衝突 → 409）。
 */
export function registerResourceRoutes(app: FastifyInstance) {
  // 22. GET /v1/resources — 列資源
  app.get("/v1/resources", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "resource.read", { type: "resource", workspace: auth.workspace })))
      return;
    return { resources: await listResources(auth.workspace) };
  });

  // 23. POST /v1/resources — 建資源
  app.post("/v1/resources", async (req, reply) => {
    const auth = req.auth!;
    const parsed = ResourceInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send(problem(422, "validation", parsed.error.message));
    }
    if (!(await enforce(req, reply, "resource.create", { type: "resource", workspace: auth.workspace })))
      return;
    const resource = await createResource(auth.workspace, parsed.data);
    await writeAudit(auth.workspace, {
      actor_type: "user",
      actor_id: null,
      action: "resource.create",
      target_type: "resource",
      target_id: resource.id,
      decision: "allow",
      metadata: { by: auth.sub, name: resource.name },
    });
    return reply.code(201).send(resource);
  });

  // 24. POST /v1/resources/:id/bookings — 預訂（防雙訂）
  app.post<{ Params: { id: string } }>(
    "/v1/resources/:id/bookings",
    async (req, reply) => {
      const auth = req.auth!;
      const parsed = BookingInput.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send(problem(422, "validation", parsed.error.message));
      }
      if (!(await enforce(req, reply, "resource.book", { type: "resource", workspace: auth.workspace })))
        return;
      try {
        const booking = await bookResource(auth.workspace, {
          resource_id: req.params.id,
          event_id: parsed.data.event_id,
          start_utc: parsed.data.start_utc,
          end_utc: parsed.data.end_utc,
        });
        await writeAudit(auth.workspace, {
          actor_type: "user",
          actor_id: null,
          action: "resource.book",
          target_type: "resource_booking",
          target_id: booking.id,
          decision: "allow",
          metadata: { by: auth.sub, resource_id: req.params.id },
        });
        return reply.code(201).send(booking);
      } catch (e: unknown) {
        if (e instanceof BookingConflictError) {
          return reply.code(409).send({
            type: "https://api.example.com/errors/conflict",
            title: "Resource booking conflict",
            status: 409,
            detail: e.message,
          });
        }
        // FK 違反（不存在的 resource/event，含跨 workspace 已被 RLS 擋）→ 404，不洩漏存在性
        if (typeof e === "object" && e && (e as { code?: string }).code === "23503") {
          return reply.code(404).send(problem(404, "not-found"));
        }
        return reply.code(422).send(problem(422, "validation", e instanceof Error ? e.message : String(e)));
      }
    },
  );

  // 25. DELETE /v1/resources/:id/bookings/:bid — 取消預訂
  app.delete<{ Params: { id: string; bid: string } }>(
    "/v1/resources/:id/bookings/:bid",
    async (req, reply) => {
      const auth = req.auth!;
      if (!(await enforce(req, reply, "resource.book", { type: "resource", workspace: auth.workspace })))
        return;
      const removed = await cancelBooking(auth.workspace, req.params.id, req.params.bid);
      if (!removed) return reply.code(404).send(problem(404, "not-found"));
      await writeAudit(auth.workspace, {
        actor_type: "user",
        actor_id: null,
        action: "resource.unbook",
        target_type: "resource_booking",
        target_id: req.params.bid,
        decision: "allow",
        metadata: { by: auth.sub, resource_id: req.params.id },
      });
      return reply.code(204).send();
    },
  );
}
