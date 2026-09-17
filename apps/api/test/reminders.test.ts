import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  remindersQueue,
  redisConnection,
  reminderJobId,
  scheduleReminder,
  rescheduleReminder,
  cancelReminder,
} from "../src/reminders/queue.js";
import { bookResource, BookingConflictError } from "../src/resources/service.js";

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
  // 清並建一個資源 + 一個事件供預訂
  await admin.query(`DELETE FROM resource_bookings WHERE workspace_id=$1`, [ws]);
  await admin.query(`DELETE FROM resources WHERE workspace_id=$1 AND name='TestRoom'`, [ws]);
  const res = (await admin.query(
    `INSERT INTO resources(workspace_id,name,type) VALUES($1,'TestRoom','room') RETURNING id`, [ws],
  )).rows[0].id;
  const ev = (await admin.query(
    `INSERT INTO events(workspace_id,calendar_id,title,start_utc,end_utc,timezone,created_by)
     VALUES($1,$2,'ResEvt','2026-12-01T06:00:00Z','2026-12-01T07:00:00Z','UTC',$3) RETURNING id`,
    [ws, cal, mem],
  )).rows[0].id;
  await admin.end();
  return { ws, cal, mem, res, ev };
}

let C: Awaited<ReturnType<typeof ctx>>;
beforeAll(async () => { C = await ctx(); });
afterAll(async () => { await remindersQueue.close(); await redisConnection.quit(); });

describe("reminders delayed jobs (REM-*/ASYNC-*)", () => {
  const base = {
    workspaceId: "w", eventId: "e1", occurrenceStartUtc: "2999-01-01T10:00:00Z",
    memberId: "m1", leadMinutes: 10,
  };

  it("穩定 jobId 含 lead 維度", () => {
    expect(reminderJobId(base)).toBe("reminder.e1.2999-01-01T10-00-00Z.m1.10");
  });

  it("排程未來提醒 → 建立 delayed job", async () => {
    const id = await scheduleReminder(base);
    expect(id).toBe(reminderJobId(base));
    const job = await remindersQueue.getJob(id!);
    expect(job).toBeTruthy();
    expect(job!.opts.delay).toBeGreaterThan(0);
    await job!.remove();
  });

  it("已過期時間 → 不排（回 null）", async () => {
    const id = await scheduleReminder({ ...base, occurrenceStartUtc: "2000-01-01T00:00:00Z" });
    expect(id).toBeNull();
  });

  it("改期 → 舊 job 移除、新 job 建立", async () => {
    await scheduleReminder(base);
    const newId = await rescheduleReminder(base, "2999-02-02T10:00:00Z");
    const oldJob = await remindersQueue.getJob(reminderJobId(base));
    expect(oldJob).toBeUndefined();
    expect(newId).toContain("2999-02-02");
    await (await remindersQueue.getJob(newId!))?.remove();
  });

  it("取消 → job 移除", async () => {
    await scheduleReminder(base);
    await cancelReminder(base);
    expect(await remindersQueue.getJob(reminderJobId(base))).toBeUndefined();
  });
});

describe("resource booking 防雙訂 (REQ-R2)", () => {
  it("首次預訂成功", async () => {
    const b = await bookResource(C.ws, {
      resource_id: C.res, event_id: C.ev,
      start_utc: "2026-12-01T06:00:00Z", end_utc: "2026-12-01T07:00:00Z",
    });
    expect(b.id).toBeTruthy();
  });

  it("同資源重疊時段 → BookingConflictError（DB EXCLUDE）", async () => {
    await expect(
      bookResource(C.ws, {
        resource_id: C.res, event_id: C.ev,
        start_utc: "2026-12-01T06:30:00Z", end_utc: "2026-12-01T07:30:00Z",
      }),
    ).rejects.toBeInstanceOf(BookingConflictError);
  });
});
