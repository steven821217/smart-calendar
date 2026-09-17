import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import { createEvent, getEvent, listOccurrences } from "../src/events/service.js";
import { withWorkspace } from "../src/db/pool.js";

async function ctx() {
  const admin = new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
  await admin.connect();
  const ws = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  const cal = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 LIMIT 1`, [ws])).rows[0].id;
  const mem = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [ws])).rows[0].id;
  await admin.end();
  return { ws, cal, mem };
}

let WS: string, CAL: string, MEM: string;
beforeAll(async () => {
  const c = await ctx();
  WS = c.ws; CAL = c.cal; MEM = c.mem;
  // 清除本測試先前建立的事件，確保可重複執行（測試隔離）
  const admin = new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
  await admin.connect();
  await admin.query(
    `DELETE FROM events WHERE workspace_id=$1 AND title IN ('One-off','Weekly','bad','secret')`,
    [WS],
  );
  await admin.end();
});

describe("event CRUD (EV-*)", () => {
  it("建立單次事件並可取回", async () => {
    const ev = await createEvent(WS, {
      calendar_id: CAL, title: "One-off",
      start_utc: "2026-10-01T06:00:00Z", end_utc: "2026-10-01T07:00:00Z",
      timezone: "Asia/Taipei", created_by: MEM,
    });
    expect(ev.id).toBeTruthy();
    const got = await getEvent(WS, ev.id);
    expect(got.title).toBe("One-off");
  });

  it("建立每週 master，GET from/to 展開 occurrences", async () => {
    await createEvent(WS, {
      calendar_id: CAL, title: "Weekly",
      start_utc: "2026-10-06T06:00:00Z", end_utc: "2026-10-06T06:30:00Z",
      timezone: "Asia/Taipei", rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=3", created_by: MEM,
    });
    const occ = await listOccurrences(
      WS, new Date("2026-10-01T00:00:00Z"), new Date("2026-12-01T00:00:00Z"),
    );
    const weekly = occ.filter((o) => o.title === "Weekly");
    expect(weekly).toHaveLength(3);
  });

  it("end<=start 由 DB CHECK 拒絕", async () => {
    await expect(
      createEvent(WS, {
        calendar_id: CAL, title: "bad",
        start_utc: "2026-10-01T07:00:00Z", end_utc: "2026-10-01T06:00:00Z",
        timezone: "UTC", created_by: MEM,
      }),
    ).rejects.toThrow();
  });

  it("跨 workspace 取事件回 null（RLS）", async () => {
    const ev = await createEvent(WS, {
      calendar_id: CAL, title: "secret",
      start_utc: "2026-10-02T06:00:00Z", end_utc: "2026-10-02T07:00:00Z",
      timezone: "UTC", created_by: MEM,
    });
    // 用他 workspace 脈絡取 → RLS 過濾 → null
    const other = "00000000-0000-0000-0000-000000000000";
    const got = await getEvent(other, ev.id);
    expect(got).toBeNull();
  });
});
