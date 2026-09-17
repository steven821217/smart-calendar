import pkg from "rrule";
const { RRule, RRuleSet, rrulestr } = pkg;

export interface MasterEvent {
  id: string;
  title: string;
  start_utc: string; // ISO UTC
  end_utc: string;
  timezone: string;
  rrule: string | null;
  rdate?: string[];
  exdate?: string[];
  source?: string; // app | agent（供前端標記 AI 排的事件）
}

export interface ExceptionEvent {
  id: string;
  recurrence_id: string; // 被覆寫 occurrence 的原始 UTC
  start_utc: string;
  end_utc: string;
  title: string;
}

export interface Occurrence {
  event_id: string;
  occurrence_start_utc: string;
  occurrence_end_utc: string;
  title: string;
  timezone: string;
  kind: "master_instance" | "exception";
  is_exception: boolean;
  exception_id: string | null;
  source: string; // app | agent
}

const MAX_OCCURRENCES = 1000; // REC-5 硬上限，防無界展開爆炸

/**
 * 於 [windowStart, windowEnd) 展開重複事件（應用層，REC-2）。
 * - 單次事件：若落在窗口內回一筆。
 * - master：以 rrule 展開 + rdate 併入 + exdate 排除，再以 exception 覆寫對應 occurrence。
 * DST：rrule 依 dtstart 計算；此處以 UTC 瞬時展開（TZ-3 DB 不介入）。
 */
export function expandOccurrences(
  master: MasterEvent,
  exceptions: ExceptionEvent[],
  windowStart: Date,
  windowEnd: Date,
): Occurrence[] {
  const durationMs =
    new Date(master.end_utc).getTime() - new Date(master.start_utc).getTime();

  // 單次事件
  if (!master.rrule) {
    const s = new Date(master.start_utc);
    if (s >= windowStart && s < windowEnd) {
      return [
        {
          event_id: master.id,
          occurrence_start_utc: master.start_utc,
          occurrence_end_utc: master.end_utc,
          title: master.title,
          timezone: master.timezone,
          kind: "master_instance",
          is_exception: false,
          exception_id: null,
          source: master.source ?? "app",
        },
      ];
    }
    return [];
  }

  // 組 RRuleSet（rrule + rdate + exdate）
  const set = new RRuleSet();
  const dtstart = new Date(master.start_utc);
  const rule = rrulestr(
    master.rrule.startsWith("DTSTART") ? master.rrule : `RRULE:${master.rrule}`,
    { dtstart },
  );
  set.rrule(new RRule({ ...rule.origOptions, dtstart }));
  for (const rd of master.rdate ?? []) set.rdate(new Date(rd));
  for (const ex of master.exdate ?? []) set.exdate(new Date(ex));

  const starts = set.between(windowStart, windowEnd, true).slice(0, MAX_OCCURRENCES);

  // exception 以 recurrence_id 對齊
  const exByRid = new Map(exceptions.map((e) => [new Date(e.recurrence_id).getTime(), e]));

  const out: Occurrence[] = [];
  for (const st of starts) {
    const ex = exByRid.get(st.getTime());
    if (ex) {
      out.push({
        event_id: master.id,
        occurrence_start_utc: new Date(ex.start_utc).toISOString(),
        occurrence_end_utc: new Date(ex.end_utc).toISOString(),
        title: ex.title,
        timezone: master.timezone,
        kind: "exception",
        is_exception: true,
        exception_id: ex.id,
        source: master.source ?? "app",
      });
    } else {
      out.push({
        event_id: master.id,
        occurrence_start_utc: st.toISOString(),
        occurrence_end_utc: new Date(st.getTime() + durationMs).toISOString(),
        title: master.title,
        timezone: master.timezone,
        kind: "master_instance",
        is_exception: false,
        exception_id: null,
        source: master.source ?? "app",
      });
    }
  }
  return out;
}
