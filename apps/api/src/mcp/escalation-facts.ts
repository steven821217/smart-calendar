/**
 * 升級時要附上的事實。
 *
 * 設計原則：升級的目的是讓呼叫端**一次就能完成推理**，不必再往返。
 * 因此這裡用確定性時間解析（不呼叫模型）決定要抓哪個範圍，把原始事實一次備齊：
 *   - 時間窗內的行程（含起訖、地點）
 *   - 若問句點名了某個主題，再補該主題的跨期間搜尋結果（同名多場的情況要一次給全）
 *   - 待回覆邀請（判斷型問題常需要）
 *
 * 為什麼不呼叫模型：能力缺口類的問題（總共幾小時、哪些重疊）無論本地模型怎麼理解都算不出來，
 * 先跑一次 14B 只是白付 2–4 秒。時間詞由既有的確定性解析處理即可。
 */
import type { AuthContext } from "../auth/jwt.js";
import { listOccurrencesForMember } from "../events/service.js";
import { listPendingForMember } from "../events/rsvp_service.js";
import { defaultWindow, windowFromSpec } from "../agents/inapp/time-window.js";
import { isNoiseKeyword, normalizeSpec, reconcileSpec, subjectKeywordFromText } from "../agents/inapp/query-spec.js";

/** 單次升級最多附上的行程筆數，避免塞爆呼叫端 context。 */
const MAX_FACT_EVENTS = 60;

interface FactEvent {
  event_id: string;
  title: string;
  start_utc: string;
  end_utc: string;
  duration_minutes: number;
  location: string | null;
}

function toFact(o: {
  event_id: string;
  title: string;
  occurrence_start_utc: string;
  occurrence_end_utc: string;
  location: string | null;
}): FactEvent {
  const start = new Date(o.occurrence_start_utc);
  const end = new Date(o.occurrence_end_utc);
  return {
    event_id: o.event_id,
    title: o.title,
    start_utc: o.occurrence_start_utc,
    end_utc: o.occurrence_end_utc,
    duration_minutes: Math.round((end.getTime() - start.getTime()) / 60_000),
    location: o.location ?? null,
  };
}

export async function gatherFactsForEscalation(
  auth: AuthContext,
  question: string,
  tz: string,
  now = new Date(),
  operators: string[] = [],
): Promise<Record<string, unknown>> {
  // 時間範圍：完全由確定性解析決定（不呼叫模型）
  const spec = reconcileSpec(normalizeSpec({ intent: "list" }), question, []);
  const hasTimeHint = spec.anchor !== "none" || spec.weekday_from !== null;
  // 無界列舉與相依查詢的重點就是「預設 7 天會截斷」，因此附事實時必須放寬範圍，
  // 否則升級等於把同一個截斷問題原封不動丟給呼叫端（實測 EX04 因此漏掉第 9 天的行程）。
  const needsWideScope = operators.some((o) => o === "unbounded_enumeration" || o === "dependent_lookup");
  const win = hasTimeHint
    ? windowFromSpec(spec.anchor, spec.weekday_from, spec.weekday_to, tz, now)
    : needsWideScope
      ? {
          from_utc: new Date(now.getTime() - 30 * 86400_000).toISOString(),
          to_utc: new Date(now.getTime() + 90 * 86400_000).toISOString(),
          label: "前 30 天至後 90 天（無界列舉需跨越預設窗）",
        }
      : defaultWindow(tz, now);

  const inWindow = await listOccurrencesForMember(
    auth.workspace,
    auth.sub,
    new Date(win.from_utc),
    new Date(win.to_utc),
  );

  // 問句點名了主題 → 該主題可能落在時間窗外（同名多場、下週的會），另外補一份跨期間搜尋
  const subject = (() => {
    const explicit = spec.filter_keyword;
    if (explicit) return explicit;
    const inferred = subjectKeywordFromText(question);
    return inferred && !isNoiseKeyword(inferred, question) ? inferred : null;
  })();

  let subjectMatches: FactEvent[] = [];
  if (subject) {
    const wide = await listOccurrencesForMember(
      auth.workspace,
      auth.sub,
      new Date(now.getTime() - 90 * 86400_000),
      new Date(now.getTime() + 180 * 86400_000),
    );
    subjectMatches = wide
      .filter((o) => o.title.includes(subject) || (o.location?.includes(subject) ?? false))
      .slice(0, MAX_FACT_EVENTS)
      .map(toFact);
  }

  let pending: Array<{ title: string; start_utc: string; organizer: string | null }> = [];
  try {
    const rows = await listPendingForMember(auth.workspace, auth.sub);
    pending = rows.slice(0, 20).map((p) => ({
      title: p.title,
      start_utc: p.start_utc,
      organizer: (p as { organizer_name?: string | null }).organizer_name ?? null,
    }));
  } catch {
    pending = [];
  }

  const events = inWindow
    .slice()
    .sort((a, b) => +new Date(a.occurrence_start_utc) - +new Date(b.occurrence_start_utc))
    .slice(0, MAX_FACT_EVENTS)
    .map(toFact);

  return {
    window: { from_utc: win.from_utc, to_utc: win.to_utc, label: win.label, timezone: tz },
    // 以本地時區換算後的欄位一併提供，省得呼叫端自己換算時區出錯
    // （實測 minimax-m2.1 在時區換算上出過錯）
    events: events.map((e) => ({
      ...e,
      local_start: new Intl.DateTimeFormat("zh-TW", {
        timeZone: tz, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).format(new Date(e.start_utc)),
      local_end: new Intl.DateTimeFormat("zh-TW", {
        timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).format(new Date(e.end_utc)),
      local_date: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
        .format(new Date(e.start_utc)),
    })),
    truncated: inWindow.length > MAX_FACT_EVENTS,
    total_in_window: inWindow.length,
    ...(subject ? { subject_keyword: subject, subject_matches: subjectMatches } : {}),
    pending_invitations: pending,
    working_hours: { start: 9, end: 18, note: "空檔類推理的慣例工作時間" },
  };
}
