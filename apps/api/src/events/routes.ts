import type { FastifyInstance } from "fastify";
import { EventInput, ParseInput, parseEventFromText } from "@scal/shared";
import { enforce } from "../auth/pep.js";
import { createEvent, getEvent, listOccurrences, updateEvent, deleteEvent, type Scope } from "./service.js";
import { publishEvent, type WebhookEventType } from "../integrations/webhooks.js";
import { verifyRsvpToken, OptionTokenError } from "../agents/option_token.js";
import { applyRsvp, RsvpError, listPendingForMember } from "./rsvp_service.js";
import { z } from "zod";

const RsvpInput = z.object({
  option_token: z.string().min(1),
  decision: z.enum(["accept", "decline"]),
});

// 生命週期 webhook 為 best-effort：佇列不可用不得阻斷 API 主路徑（ASYNC 精神）
function emit(workspaceId: string, type: WebhookEventType, payload: Record<string, unknown> & { id?: string }) {
  publishEvent(workspaceId, type, payload).catch(() => {
    /* 佇列不可用時忽略；正式環境應記可觀測性指標 */
  });
}

export function registerEventRoutes(app: FastifyInstance) {
  // 登入使用者的「待處理」收件匣：agent 幫他排、尚未回覆的 pending 邀請。
  // 認證用登入 JWT（sub = membership id）；只回本人的，經 RLS/workspace 兜底。
  app.get("/v1/me/pending-rsvps", async (req) => {
    const auth = req.auth!;
    const pending = await listPendingForMember(auth.workspace, auth.sub);
    return { pending };
  });

  // RSVP（feature-team-groups Req 3.2）：Member 憑 rsvp_token 對 pending 事件回覆 accept/decline。
  // 認證憑證 = 後端簽章的 rsvp_token 本身（免登入 JWT；hook 已放行本路徑）。
  // accept → 事件正式排入（rsvp_status='accepted'）；decline → 'declined'。
  app.post<{ Params: { id: string } }>("/v1/events/:id/rsvp", async (req, reply) => {
    const parsed = RsvpInput.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(422)
        .send({ type: "…/validation", title: "Unprocessable", status: 422, detail: parsed.error.message });
    }
    let claims;
    try {
      claims = verifyRsvpToken(parsed.data.option_token);
    } catch (e) {
      if (e instanceof OptionTokenError) {
        return reply.code(401).send({ type: "…/unauthorized", title: "unauthorized", status: 401, detail: e.message });
      }
      throw e;
    }
    // token 綁 event_id：路徑 id 必須與 token 一致（防拿 A 事件的 token 改 B 事件）
    if (claims.event_id !== req.params.id) {
      return reply.code(403).send({ type: "…/forbidden", title: "forbidden", status: 403, detail: "token event mismatch" });
    }
    try {
      const result = await applyRsvp(claims.workspace, claims.event_id, claims.member_id, parsed.data.decision);
      // 通知生命週期：接受→event.updated；供訂閱者/UI 反映最終行事曆狀態（best-effort）
      emit(claims.workspace, "event.updated", { id: claims.event_id, rsvp: result });
      return { status: "ok", ...result };
    } catch (e) {
      if (e instanceof RsvpError) {
        const code = e.code === "not_found" ? 404 : 422;
        return reply.code(code).send({ type: "…/error", title: e.code, status: code, detail: e.message });
      }
      throw e;
    }
  });

  // 19. POST /v1/events/parse — NL → 事件草稿（不落 DB，供一鍵確認建立）
  app.post("/v1/events/parse", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "event.create", { type: "event", workspace: auth.workspace })))
      return;
    const parsed = ParseInput.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(422)
        .send({ type: "…/validation", title: "Unprocessable", status: 422, detail: parsed.error.message });
    }
    const draft = parseEventFromText(parsed.data);
    return { draft };
  });

  // 建立事件（PEP: event.create → Service → RLS）
  app.post("/v1/events", async (req, reply) => {
    const parsed = EventInput.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(422)
        .send({ type: "…/validation", title: "Unprocessable", status: 422, detail: parsed.error.message });
    }
    const auth = req.auth!;
    if (!(await enforce(req, reply, "event.create", { type: "event", workspace: auth.workspace })))
      return;
    try {
      const ev = await createEvent(auth.workspace, {
        ...parsed.data,
        created_by: auth.sub, // 由 membership 對映，此處簡化
      } as never);
      emit(auth.workspace, "event.created", { id: ev.id, event: ev });
      return reply.code(201).send(ev);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // 衝突（EXCLUDE / unique）→ 409；其餘 → 422
      const code = /exclusion|unique|conflict/i.test(msg) ? 409 : 422;
      return reply.code(code).send({ type: "…/error", title: code === 409 ? "Conflict" : "Unprocessable", status: code, detail: msg });
    }
  });

  // 取單筆
  app.get<{ Params: { id: string } }>("/v1/events/:id", async (req, reply) => {
    const auth = req.auth!;
    const ev = await getEvent(auth.workspace, req.params.id);
    if (!ev) return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
    if (!(await enforce(req, reply, "event.read", {
      type: "event", workspace: auth.workspace, owner_id: ev.created_by, visibility: ev.visibility,
    }))) return;
    return ev;
  });

  // 列表 / 展開 occurrences
  app.get<{ Querystring: { from?: string; to?: string; calendar_id?: string } }>(
    "/v1/events",
    async (req, reply) => {
      const auth = req.auth!;
      const { from, to, calendar_id } = req.query;
      if (!(await enforce(req, reply, "event.read", { type: "event", workspace: auth.workspace })))
        return;
      if (from && to) {
        const occ = await listOccurrences(auth.workspace, new Date(from), new Date(to), calendar_id);
        return { occurrences: occ, next_cursor: null };
      }
      if (from || to) {
        return reply.code(422).send({ type: "…/validation", title: "from and to required together", status: 422 });
      }
      return { events: [], next_cursor: null };
    },
  );

  // 更新（scope）
  app.patch<{ Params: { id: string }; Querystring: { scope?: Scope } }>(
    "/v1/events/:id",
    async (req, reply) => {
      const auth = req.auth!;
      const ev = await getEvent(auth.workspace, req.params.id);
      if (!ev) return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
      if (!(await enforce(req, reply, "event.update", {
        type: "event", workspace: auth.workspace, owner_id: ev.created_by, visibility: ev.visibility,
      }))) return;
      try {
        const r = await updateEvent(auth.workspace, req.params.id, req.query.scope ?? "all", (req.body ?? {}) as never);
        emit(auth.workspace, "event.updated", { id: req.params.id, scope: req.query.scope ?? "all", event: r });
        return r;
      } catch (e: unknown) {
        return reply.code(422).send({ type: "…/validation", title: "Unprocessable", status: 422, detail: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // 刪除（scope）
  app.delete<{ Params: { id: string }; Querystring: { scope?: Scope; occurrence_start_utc?: string } }>(
    "/v1/events/:id",
    async (req, reply) => {
      const auth = req.auth!;
      const ev = await getEvent(auth.workspace, req.params.id);
      if (!ev) return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
      if (!(await enforce(req, reply, "event.delete", {
        type: "event", workspace: auth.workspace, owner_id: ev.created_by, visibility: ev.visibility,
      }))) return;
      try {
        await deleteEvent(auth.workspace, req.params.id, req.query.scope ?? "all", req.query.occurrence_start_utc);
        emit(auth.workspace, "event.deleted", { id: req.params.id, scope: req.query.scope ?? "all" });
        return reply.code(204).send();
      } catch (e: unknown) {
        return reply.code(422).send({ type: "…/validation", title: "Unprocessable", status: 422, detail: e instanceof Error ? e.message : String(e) });
      }
    },
  );
}
