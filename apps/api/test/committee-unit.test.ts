import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import type { z } from "zod";
import type { AuthContext } from "../src/auth/jwt.js";
import type { ChatModel, ChatMessage } from "../src/agents/llm.js";
import { makeCoordinator } from "../src/agents/nodes/coordinator.js";
import { makeNegotiator } from "../src/agents/nodes/negotiator.js";
import { expandWithBuffer } from "../src/agents/service.js";
import { type CommitteeStateType } from "../src/agents/state.js";
import { createEvent } from "../src/events/service.js";

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let WS: string, CAL: string, MEM: string;

beforeAll(async () => {
  const admin = adminClient();
  await admin.connect();
  WS = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  CAL = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 LIMIT 1`, [WS])).rows[0].id;
  MEM = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [WS])).rows[0].id;
  await admin.end();
});

const ctx = (): AuthContext => ({
  sub: MEM,
  workspace: WS,
  roles: ["member"],
  scope: ["availability.read", "event.write", "resource.book"],
});

/** stub model：回固定 structured 解析結果。 */
function stubModel(result: unknown): ChatModel {
  return {
    async invokeStructured<T>(_schema: z.ZodType<T>, _messages: ChatMessage[]): Promise<T> {
      return result as T;
    },
  };
}

function throwingModel(): ChatModel {
  return {
    async invokeStructured() {
      throw new Error("stub LLM boom");
    },
  };
}

/** 以 default 值補齊一個部分 state（避免測試手動填每個欄位）。 */
function baseState(over: Partial<CommitteeStateType>): CommitteeStateType {
  const base: CommitteeStateType = {
    task_description: "",
    reference_now_utc: "2026-09-15T00:00:00Z",
    default_timezone: "UTC",
    confirm: false,
    explain: false,
    attendees: [],
    resources: [],
    timeframe: null,
    candidate: undefined,
    options: [],
    booking_plan: undefined,
    trace: [],
    status: "pending",
    message: undefined,
    code: undefined,
    result: undefined,
  };
  return { ...base, ...over };
}

describe("Committee — coordinator (E.1)", () => {
  it("stub model 唯一比對 member → attendees 帶該 id", async () => {
    const coord = makeCoordinator({
      ctx: ctx(),
      model: stubModel({ attendee_ids: [MEM], unresolved_names: [], resources: [{ kind: "vehicle" }] }),
    });
    const out = await coord(
      baseState({ task_description: "跟 Bob 借公務車，下週三下午", reference_now_utc: "2026-09-15T00:00:00Z", default_timezone: "Asia/Taipei" }),
    );
    expect(out.status).toBe("pending");
    expect(out.attendees).toContain(MEM);
    expect(out.resources?.[0].kind).toBe("vehicle");
    expect(out.timeframe).toBeTruthy();
  });

  it("解析不足（未解析名字且無 attendee）→ needs_clarification", async () => {
    const coord = makeCoordinator({
      ctx: ctx(),
      model: stubModel({ attendee_ids: [], unresolved_names: ["Bob"], resources: [] }),
    });
    const out = await coord(baseState({ task_description: "跟 Bob 開會 明天下午", default_timezone: "Asia/Taipei" }));
    expect(out.status).toBe("needs_clarification");
    expect(out.message).toContain("Bob");
  });

  it("LLM 幻覺 id（不在 roster）被過濾（ZT）", async () => {
    const coord = makeCoordinator({
      ctx: ctx(),
      model: stubModel({ attendee_ids: ["00000000-0000-0000-0000-000000000000"], unresolved_names: [], resources: [] }),
    });
    const out = await coord(baseState({ task_description: "明天下午 3 點會議", default_timezone: "Asia/Taipei" }));
    expect(out.attendees).toEqual([]);
  });
});

describe("Committee — coordinator termination (E.6)", () => {
  it("stub model 拋錯 → status=error（不掛死）", async () => {
    const coord = makeCoordinator({ ctx: ctx(), model: throwingModel() });
    const out = await coord(baseState({ task_description: "明天下午開會", default_timezone: "Asia/Taipei" }));
    expect(out.status).toBe("error");
    expect(out.code).toBe("llm_unavailable");
  });
});

describe("Committee — negotiator (E.2)", () => {
  it("造構 busy → 首選 + 至多 3 備案（分數排序）", async () => {
    // 建一筆忙碌事件供 computeAvailability 反映
    await createEvent(WS, {
      calendar_id: CAL, title: "NegBusy",
      start_utc: "2027-08-04T02:00:00Z", end_utc: "2027-08-04T03:00:00Z",
      timezone: "UTC", created_by: MEM,
    });
    const nego = makeNegotiator({ ctx: ctx() });
    const out = await nego(
      baseState({
        timeframe: { from_utc: "2027-08-04T00:00:00Z", to_utc: "2027-08-04T08:00:00Z", duration_minutes: 60 },
        attendees: [],
      }),
    );
    expect(out.status).toBe("pending");
    expect(out.candidate).toBeTruthy();
    expect((out.options ?? []).length).toBeGreaterThan(0);
    expect((out.options ?? []).length).toBeLessThanOrEqual(3);
    // 分數遞減排序
    const opts = out.options ?? [];
    for (let i = 1; i < opts.length; i++) expect(opts[i - 1].score).toBeGreaterThanOrEqual(opts[i].score);
    // 首選不與忙碌重疊
    const bs = Date.parse("2027-08-04T02:00:00Z"), be = Date.parse("2027-08-04T03:00:00Z");
    const cs = Date.parse(out.candidate!.start_utc), ce = Date.parse(out.candidate!.end_utc);
    expect(cs < be && bs < ce).toBe(false);
  });

  it("窗口內無空檔 → status=error(no_availability)", async () => {
    // 塞滿整個窗口
    await createEvent(WS, {
      calendar_id: CAL, title: "NegFull",
      start_utc: "2027-08-05T00:00:00Z", end_utc: "2027-08-05T01:00:00Z",
      timezone: "UTC", created_by: MEM,
    });
    const nego = makeNegotiator({ ctx: ctx() });
    const out = await nego(
      baseState({
        timeframe: { from_utc: "2027-08-05T00:00:00Z", to_utc: "2027-08-05T00:30:00Z", duration_minutes: 60 },
        attendees: [],
      }),
    );
    expect(out.status).toBe("error");
    expect(out.code).toBe("no_availability");
  });
});

describe("Committee — buffer 邊界半開區間 (E.3, REQ-4)", () => {
  // 前一筆預訂 10:00-10:30。新使用 10:45-11:15，buffer=15：
  //  擴張後 [10:30, 11:30]。前一筆 [10:00,10:30]。端點 10:30 相接 → 半開 [) 不重疊 → 15 分鐘剛好。
  const prevStart = Date.parse("2027-01-01T10:00:00Z");
  const prevEnd = Date.parse("2027-01-01T10:30:00Z");
  const overlapHalfOpen = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;

  const check = (gapMinutes: number, buffer = 15) => {
    const useStart = prevEnd + gapMinutes * 60_000;
    const useEnd = useStart + 30 * 60_000;
    const exp = expandWithBuffer(new Date(useStart).toISOString(), new Date(useEnd).toISOString(), buffer);
    return overlapHalfOpen(Date.parse(exp.start_utc), Date.parse(exp.end_utc), prevStart, prevEnd);
  };

  it("間隔 14 分鐘 → 衝突", () => {
    expect(check(14)).toBe(true);
  });
  it("間隔 15 分鐘 → 剛好不衝突（半開端點相接）", () => {
    expect(check(15)).toBe(false);
  });
  it("間隔 16 分鐘 → 可用", () => {
    expect(check(16)).toBe(false);
  });
});
