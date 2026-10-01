import type { FastifyInstance } from "fastify";
import { EventInput, ParseInput, ParticipantsInput, parseEventFromText } from "@scal/shared";
import { enforce } from "../auth/pep.js";
import { UnknownParticipantEmailError, createEvent, getEvent, listEventParticipants, listOccurrencesForMember, memberCanSeeEvent, replaceEventParticipants, updateEvent, deleteEvent, type Scope } from "./service.js";
import { publishEvent, type WebhookEventType } from "../integrations/webhooks.js";
import { verifyRsvpToken, OptionTokenError } from "../agents/option_token.js";
import { applyRsvp, RsvpError, listPendingForMember } from "./rsvp_service.js";
import { withWorkspace } from "../db/pool.js";
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
    // 寫入隔離：只能建在**自己擁有**的行事曆上。OPA 的 event.create 只看 workspace + 角色，
    // 若不在此核對 calendar 擁有者，任何 member 都能把事件塞進 leader 的日曆。
    // （agent 代排走委員會/MCP 另有路徑，仍以授權者本人的日曆為主體。）
    const ownsCalendar = await withWorkspace(auth.workspace, async (c) => {
      const r = await c.query(`SELECT 1 FROM calendars WHERE id = $1 AND owner_id = $2`, [
        parsed.data.calendar_id,
        auth.sub,
      ]);
      return r.rowCount === 1;
    });
    if (!ownsCalendar) {
      // 不洩漏「該行事曆存在但不屬於你」→ 一律 404
      return reply
        .code(404)
        .send({ type: "…/not-found", title: "Not Found", status: 404, detail: "行事曆不存在或不屬於你。" });
    }
    try {
      const ev = await createEvent(auth.workspace, {
        ...parsed.data,
        created_by: auth.sub, // 由 membership 對映，此處簡化
      } as never);
      // 與會者：schema 早就接受 participants，但先前服務層完全忽略 → 邀請被默默丟掉。
      // 這裡落實寫入；建立者為 organizer(accepted)，其他人 pending（待對方回覆）。
      const incoming = parsed.data.participants ?? [];
      let participants;
      try {
        participants = await replaceEventParticipants(
          auth.workspace,
          ev.id,
          auth.sub,
          incoming.map((x) => x.member_id).filter((x): x is string => !!x),
          incoming.map((x) => x.guest_email).filter((x): x is string => !!x),
        );
      } catch (e) {
        if (e instanceof UnknownParticipantEmailError) {
          // 事件已經寫進去了，但邀請失敗。留著會變成「會議建立了卻沒邀到人」的半套狀態，
          // 使用者以為成功。因此刪掉事件並回 422，讓整個操作是全有或全無。
          await deleteEvent(auth.workspace, ev.id, "all").catch(() => {});
          return reply.code(422).send({
            type: "…/validation", title: "unknown participant email", status: 422, detail: e.message,
          });
        }
        throw e;
      }
      emit(auth.workspace, "event.created", { id: ev.id, event: ev });
      return reply.code(201).send({ ...ev, participants });
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
    // 個人隔離（與列表同規則）：OPA 對 visibility='busy'（預設值）是放行的，
    // 若不再核對本人，任何成員拿到 event id 就能讀到別人的完整內容。
    if (!(await memberCanSeeEvent(auth.workspace, auth.sub, req.params.id))) {
      return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
    }
    // 與會者名單一併回傳，站內才看得到「這場會有誰參加」
    const participants = await listEventParticipants(auth.workspace, req.params.id);
    return { ...ev, participants };
  });

  // 取代與會者名單（邀請／移除）。
  // 只有事件建立者能改——否則同 workspace 的任何人都能把別人塞進別人的會議。
  app.put<{ Params: { id: string }; Body: { member_ids?: string[]; guest_emails?: string[] } }>(
    "/v1/events/:id/participants",
    async (req, reply) => {
      const auth = req.auth!;
      const ev = await getEvent(auth.workspace, req.params.id);
      if (!ev) return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
      if (!(await enforce(req, reply, "event.update", {
        type: "event", workspace: auth.workspace, owner_id: ev.created_by, visibility: ev.visibility,
      }))) return;
      if (ev.created_by !== auth.sub) {
        // 不洩漏事件存在與否的差異
        return reply.code(404).send({
          type: "…/not-found", title: "Not Found", status: 404,
          detail: "只有發起人能調整與會者。",
        });
      }
      const parsed = ParticipantsInput.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(422).send({
          type: "…/validation", title: "Unprocessable", status: 422,
          detail: parsed.error.issues.map((i) => i.message).join("；"),
        });
      }
      let participants;
      try {
        participants = await replaceEventParticipants(
          auth.workspace,
          req.params.id,
          auth.sub,
          parsed.data.member_ids,
          parsed.data.guest_emails,
        );
      } catch (e) {
        if (e instanceof UnknownParticipantEmailError) {
          return reply.code(422).send({
            type: "…/validation", title: "unknown participant email", status: 422, detail: e.message,
          });
        }
        throw e;
      }
      emit(auth.workspace, "event.updated", { id: req.params.id, event: { ...ev, participants } });
      return { participants };
    },
  );

  // 列表 / 展開 occurrences
  //
  // 個人隔離：只回「本人擁有的日曆上的事件」＋「本人被列為參與者的事件」
  //（listOccurrencesForMember）。同 workspace 的其他人私會查不到——加入工作區
  // 不等於看得到 leader 的整本日曆。leader 幫團隊排的會、agent 代排的會，因為
  // member 是 participant（pending 或 accepted 皆然）所以看得到，RSVP 流程才成立。
  // 與站內/外部 agent 的查詢走同一條函式，避免「問 agent 隔離、看月曆卻全都露」。
  app.get<{ Querystring: { from?: string; to?: string; calendar_id?: string } }>(
    "/v1/events",
    async (req, reply) => {
      const auth = req.auth!;
      const { from, to } = req.query;
      if (!(await enforce(req, reply, "event.read", { type: "event", workspace: auth.workspace })))
        return;
      if (from && to) {
        const occ = await listOccurrencesForMember(auth.workspace, auth.sub, new Date(from), new Date(to));
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
