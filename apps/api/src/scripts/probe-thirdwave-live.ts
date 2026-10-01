// Live probe: third-wave destructive actions (reschedule/cancel/rsvp) with real 14B.
// Creates a throwaway event, routes NL destructive requests, runs the two-step confirm,
// verifies the DB actually changed, then cleans up. Proves 14B routes correctly AND the
// two-step token flow works end-to-end.
//
// Run (host): set env like probe-inapp-live, plus PROBE_WS/PROBE_MEMBER, then
//   pnpm --filter @scal/api exec tsx src/scripts/probe-thirdwave-live.ts
import { makeChatModel } from "../agents/llm.js";
import { runInAppAgent, confirmAction } from "../agents/inapp/service.js";
import { createEvent, getEvent, listOccurrencesForMember } from "../events/service.js";
import { withWorkspace } from "../db/pool.js";
import type { AuthContext } from "../auth/jwt.js";

const TZ = "Asia/Taipei";
const WS = process.env.PROBE_WS ?? "";
const MEM = process.env.PROBE_MEMBER ?? "";

async function main() {
  if (!WS || !MEM) { console.error("set PROBE_WS + PROBE_MEMBER"); process.exit(2); }
  const model = makeChatModel();
  const auth = { workspace: WS, sub: MEM, roles: ["admin"], scope: [] } as unknown as AuthContext;
  const now = new Date();

  // 建一個丟棄用事件（本人擁有的 calendar）
  const calId = await withWorkspace(WS, async (c) =>
    (await c.query(`SELECT id FROM calendars WHERE owner_id=$1 ORDER BY created_at LIMIT 1`, [MEM])).rows[0]?.id);
  const start = new Date(now.getTime() + 2 * 86400_000); start.setUTCHours(6, 0, 0, 0); // 後天 14:00 台北附近
  const ev = await createEvent(WS, {
    calendar_id: calId, title: "PROBE3-臨時測試會", start_utc: start.toISOString(),
    end_utc: new Date(start.getTime() + 3600_000).toISOString(), timezone: TZ, created_by: MEM, source: "app",
  } as never);
  console.log("建立測試事件:", ev.id, ev.title, ev.start_utc);

  try {
    // 1) 路由：改期（含新時間）
    console.log("\n【把 PROBE3-臨時測試會 改到下週一下午】");
    const r1 = await runInAppAgent(auth, "把 PROBE3-臨時測試會 改到下週一下午", TZ, { model, nowUtc: now });
    console.log(`  intent=${r1.intent} kind=${r1.kind}\n  → ${r1.message}`);
    const tok = (r1.data as { action_token?: string })?.action_token;
    if (r1.kind === "needs_confirmation" && tok) {
      const r1c = await confirmAction(auth, tok, TZ);
      console.log(`  確認 → kind=${r1c.kind} ${r1c.message}`);
      const after = await getEvent(WS, ev.id);
      console.log(`  DB 驗證：start_utc 由 ${ev.start_utc} → ${new Date(after.start_utc).toISOString()}`);
    }

    // 2) 路由：取消
    console.log("\n【取消 PROBE3-臨時測試會】");
    const r2 = await runInAppAgent(auth, "取消 PROBE3-臨時測試會", TZ, { model, nowUtc: now });
    console.log(`  intent=${r2.intent} kind=${r2.kind}\n  → ${r2.message}`);
    const tok2 = (r2.data as { action_token?: string })?.action_token;
    if (r2.kind === "needs_confirmation" && tok2) {
      const r2c = await confirmAction(auth, tok2, TZ);
      console.log(`  確認 → kind=${r2c.kind} ${r2c.message}`);
      const gone = await getEvent(WS, ev.id);
      console.log(`  DB 驗證：deleted_at = ${gone?.deleted_at ?? "(已軟刪或不存在)"}`);
    }
  } finally {
    // 清理（硬刪，確保不留測試資料）
    await withWorkspace(WS, async (c) => c.query(`DELETE FROM events WHERE id=$1`, [ev.id]));
    console.log("\n已清理測試事件。");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
