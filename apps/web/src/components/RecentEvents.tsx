import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Sparkles } from "lucide-react";
import { api, type Occurrence } from "@/lib/api";
import { useAuth } from "@/store/auth";
import { fmt } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * 最近事件（前後 7 天）側欄面板。
 * 讓使用者不必翻月曆就能一眼看到近期有什麼事；依觀看者時區顯示，
 * agent（AI 助理）排的事件標 ✨。每 30 秒輪詢，跟月曆一樣即時反映。
 */
export function RecentEvents() {
  const me = useAuth((s) => s.me);
  const tz = me?.timezone ?? "UTC";

  const [fromUtc, toUtc] = useMemo(() => {
    const now = Date.now();
    const day = 86_400_000;
    return [new Date(now - 7 * day).toISOString(), new Date(now + 7 * day).toISOString()];
  }, []);

  const { data } = useQuery({
    queryKey: ["recent-events", me?.workspace.id, me?.membership_id, fromUtc, toUtc],
    queryFn: () => api.listOccurrences(fromUtc, toUtc),
    refetchInterval: 120_000, // SSE 即時推播為主；輪詢僅作斷線備援
    refetchOnWindowFocus: true,
    enabled: !!me,
  });

  const occ = useMemo(
    () =>
      (data?.occurrences ?? [])
        .slice()
        .sort(
          (a, b) =>
            new Date(a.occurrence_start_utc).getTime() - new Date(b.occurrence_start_utc).getTime(),
        ),
    [data],
  );

  const todayKey = fmt(new Date().toISOString(), tz, "yyyy-MM-dd");

  const rel = (o: Occurrence) => {
    const k = fmt(o.occurrence_start_utc, tz, "yyyy-MM-dd");
    if (k === todayKey) return "today";
    return new Date(o.occurrence_start_utc).getTime() < Date.now() ? "past" : "future";
  };

  return (
    <div className="border-t border-border px-3 py-3">
      <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <CalendarClock className="h-3.5 w-3.5" aria-hidden />
        最近事件（前後 7 天）
      </div>
      {occ.length === 0 ? (
        <div className="px-1 py-3 text-center text-xs text-muted-foreground">近期沒有事件</div>
      ) : (
        <ul className="max-h-56 space-y-1 overflow-auto">
          {occ.map((o) => {
            const when = rel(o);
            return (
              <li key={`${o.event_id}-${o.occurrence_start_utc}`}>
                <a
                  href="#/calendar"
                  className={cn(
                    "block rounded-md px-2 py-1.5 text-xs transition-all hover:bg-accent hover:shadow-sm hover:translate-x-0.5",
                    when === "past" && "opacity-55",
                    when === "today" && "border-l-2 border-primary bg-primary/5",
                  )}
                >
                  <div className="flex items-center gap-1 font-medium text-foreground">
                    {o.source === "agent" && (
                      <Sparkles className="h-3 w-3 shrink-0 text-violet-500" aria-label="AI 助理安排" />
                    )}
                    <span className="truncate">{o.title}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    {when === "today" && (
                      <span className="rounded bg-primary px-1.5 py-0.5 text-xs font-semibold text-primary-foreground">
                        今天
                      </span>
                    )}
                    <span>
                      {fmt(o.occurrence_start_utc, tz, "MM/dd (EEE) HH:mm")}
                    </span>
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
