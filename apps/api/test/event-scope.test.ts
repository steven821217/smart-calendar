import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import { createEvent, getEvent, updateEvent, deleteEvent, listOccurrences } from "../src/events/service.js";

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
  await admin.query(`DELETE FROM events WHERE workspace_id=$1 AND title IN ('ScopeMaster','ScopeAll')`, [ws]);
  await admin.end();
  return { ws, cal, mem };
}
let WS: string, CAL: string, MEM: string;
beforeAll(async () => { const c = await ctx(); WS = c.ws; CAL = c.cal; MEM = c.mem; });

async function mkMaster(title: string) {
  return createEvent(WS, {
    calendar_id: CAL, title,
    start_utc: "2027-01-05T06:00:00Z", end_utc: "2027-01-05T06:30:00Z",
    timezone: "Asia/Taipei", rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=4", created_by: MEM,
  });
}

describe("event scope 語意 (EV-3/4)", () => {
  it("scope=this → 建立 exception，展開時覆寫該次", async () => {
    const m = await mkMaster("ScopeMaster");
    await updateEvent(WS, m.id, "this", {
      occurrence_start_utc: "2027-01-12T06:00:00Z",
      start_utc: "2027-01-12T08:00:00Z", end_utc: "2027-01-12T09:00:00Z", title: "Moved",
    });
    const occ = await listOccurrences(WS, new Date("2027-01-01T00:00:00Z"), new Date("2027-03-01T00:00:00Z"));
    const moved = occ.find((o) => o.title === "Moved");
    expect(moved?.is_exception).toBe(true);
    expect(moved?.occurrence_start_utc).toBe("2027-01-12T08:00:00.000Z");
  });

  it("scope=this (delete) → 該次加入 exdate，展開少一次", async () => {
    const m = await mkMaster("ScopeAll");
    const before = (await listOccurrences(WS, new Date("2027-01-01T00:00:00Z"), new Date("2027-03-01T00:00:00Z")))
      .filter((o) => o.event_id === m.id).length;
    await deleteEvent(WS, m.id, "this", "2027-01-19T06:00:00Z");
    const after = (await listOccurrences(WS, new Date("2027-01-01T00:00:00Z"), new Date("2027-03-01T00:00:00Z")))
      .filter((o) => o.event_id === m.id).length;
    expect(after).toBe(before - 1);
  });

  it("scope=all (update) → 改 master 標題", async () => {
    const m = await mkMaster("ScopeMaster");
    await updateEvent(WS, m.id, "all", { title: "RenamedAll" });
    const got = await getEvent(WS, m.id);
    expect(got.title).toBe("RenamedAll");
  });

  it("scope=all (delete) → 軟刪，getEvent 回 null", async () => {
    const m = await mkMaster("ScopeAll");
    await deleteEvent(WS, m.id, "all");
    expect(await getEvent(WS, m.id)).toBeNull();
  });
});
