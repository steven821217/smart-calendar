import type { FastifyInstance } from "fastify";
import Redis from "ioredis";
import { enforce } from "../auth/pep.js";
import { computeAvailability } from "./availability.js";
import { detectConflicts, findSlots, type Interval } from "./freebusy.js";
import { listOccurrences, getEvent } from "../events/service.js";

const redis = new Redis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

/**
 * 智慧排程端點（api.md 20/21, REQ-S1/S2）。
 * availability.read → PEP → 計算。加 Redis 短快取（30s）減少重算（5.2）。
 */
export function registerSchedulingRoutes(app: FastifyInstance) {
  // 20. GET /v1/availability
  app.get<{
    Querystring: {
      from?: string;
      to?: string;
      duration_minutes?: string;
      member_ids?: string;
      max_results?: string;
    };
  }>("/v1/availability", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "availability.read", { type: "availability", workspace: auth.workspace })))
      return;
    const { from, to, duration_minutes } = req.query;
    if (!from || !to || !duration_minutes) {
      return reply
        .code(422)
        .send({ type: "…/validation", title: "from, to, duration_minutes required", status: 422 });
    }
    const memberIds = req.query.member_ids
      ? req.query.member_ids.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    const cacheKey = `avail:${auth.workspace}:${from}:${to}:${duration_minutes}:${
      req.query.member_ids ?? ""
    }:${req.query.max_results ?? ""}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {
      // 快取不可用不影響正確性，直接算
    }

    const result = await computeAvailability(auth.workspace, {
      from_utc: from,
      to_utc: to,
      duration_minutes: Number(duration_minutes),
      member_ids: memberIds,
      max_results: req.query.max_results ? Number(req.query.max_results) : undefined,
    });
    try {
      await redis.set(cacheKey, JSON.stringify(result), "EX", 30);
    } catch {
      /* 快取寫入失敗忽略 */
    }
    return result;
  });

  // 21. POST /v1/events/:id/conflicts — 檢查該事件時段是否衝突 + 替代
  app.post<{ Params: { id: string } }>("/v1/events/:id/conflicts", async (req, reply) => {
    const auth = req.auth!;
    const ev = await getEvent(auth.workspace, req.params.id);
    if (!ev) return reply.code(404).send({ type: "…/not-found", title: "Not Found", status: 404 });
    if (!(await enforce(req, reply, "event.read", {
      type: "event", workspace: auth.workspace, owner_id: ev.created_by, visibility: ev.visibility,
    }))) return;

    const start = new Date(ev.start_utc).getTime();
    const end = new Date(ev.end_utc).getTime();
    // 以事件當日為窗口撈忙碌
    const dayStart = new Date(start); dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(start); dayEnd.setUTCHours(23, 59, 59, 999);
    const occ = await listOccurrences(auth.workspace, dayStart, dayEnd);
    const busy: Interval[] = occ
      .filter((o) => o.event_id !== ev.id) // 排除自己
      .map((o) => ({
        start: new Date(o.occurrence_start_utc).getTime(),
        end: new Date(o.occurrence_end_utc).getTime(),
      }));

    const conflicts = detectConflicts({ start, end }, busy);
    if (conflicts.length === 0) return { conflicts: [], suggested_slots: [] };

    const suggested = findSlots(busy, dayStart.getTime(), dayEnd.getTime(), end - start, 3);
    return reply.code(409).send({
      type: "https://api.example.com/errors/conflict",
      title: "Time conflict",
      status: 409,
      conflicts: conflicts.map((c) => ({
        start_utc: new Date(c.start).toISOString(),
        end_utc: new Date(c.end).toISOString(),
      })),
      suggested_slots: suggested.map((s) => ({ start_utc: s.start_utc, end_utc: s.end_utc })),
    });
  });
}
