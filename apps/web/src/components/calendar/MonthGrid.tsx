import { useEffect, useMemo, useRef } from "react";
import { Sparkles } from "lucide-react";
import { monthGridDays, isSameDay, isSameMonth, nowInViewer } from "@/lib/calendar";
import { utcToViewer, fmtTime } from "@/lib/time";
import { monthCellId } from "@/lib/drag";
import { DraggableChip, DroppableCell } from "@/components/calendar/dragParts";
import type { Occurrence } from "@/lib/api";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];
const WHEEL_THRESHOLD = 64;
const WHEEL_COOLDOWN_MS = 420;

interface Props {
  anchor: Date;
  tz: string;
  occurrences: Occurrence[];
  selectedDay?: Date | null;
  /** 點日期格（或「還有 N 個事件」）→ 開啟當日完整行程。 */
  onDayOpen?: (day: Date) => void;
  onEventClick?: (occ: Occurrence) => void;
  onNavigateMonth?: (direction: -1 | 1) => void;
}

function dayIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T00:00`;
}

/** 月視圖：42 格月曆；滾輪累積超過門檻後切月，並以冷卻避免觸控板慣性連跳。 */
export function MonthGrid({
  anchor,
  tz,
  occurrences,
  selectedDay,
  onDayOpen,
  onEventClick,
  onNavigateMonth,
}: Props) {
  const days = useMemo(() => monthGridDays(anchor), [anchor]);
  const today = useMemo(() => nowInViewer(tz), [tz]);
  const rootRef = useRef<HTMLDivElement>(null);
  const wheelDeltaRef = useRef(0);
  const cooldownUntilRef = useRef(0);
  const resetTimerRef = useRef<number>();

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onNavigateMonth) return;

    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [data-wheel-native]")) return;

      const now = Date.now();
      if (now < cooldownUntilRef.current) {
        event.preventDefault();
        return;
      }

      wheelDeltaRef.current += event.deltaY;
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => {
        wheelDeltaRef.current = 0;
      }, 180);

      if (Math.abs(wheelDeltaRef.current) < WHEEL_THRESHOLD) return;
      event.preventDefault();
      onNavigateMonth(wheelDeltaRef.current > 0 ? 1 : -1);
      wheelDeltaRef.current = 0;
      cooldownUntilRef.current = now + WHEEL_COOLDOWN_MS;
    };

    root.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      root.removeEventListener("wheel", onWheel);
      window.clearTimeout(resetTimerRef.current);
    };
  }, [onNavigateMonth]);

  const byDay = useMemo(() => {
    const grouped = new Map<string, Occurrence[]>();
    for (const occurrence of occurrences) {
      const local = utcToViewer(occurrence.occurrence_start_utc, tz);
      const key = `${local.getFullYear()}-${local.getMonth()}-${local.getDate()}`;
      (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(occurrence);
    }
    return grouped;
  }, [occurrences, tz]);

  const keyOf = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

  return (
    <div
      ref={rootRef}
      className="flex h-full min-w-[700px] flex-col bg-background"
      role="region"
      aria-label={`${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月月曆；可使用滑鼠滾輪切換月份`}
      title="在月曆上使用滑鼠滾輪切換月份"
    >
      <div className="grid h-10 shrink-0 grid-cols-7 border-b border-border bg-muted/25 text-xs font-medium text-muted-foreground">
        {WEEKDAYS.map((weekday, index) => (
          <div key={weekday} className={cn("flex items-center justify-center", index >= 5 && "text-foreground/70")}>
            {weekday}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 auto-rows-fr border-l border-border">
        {days.map((day, index) => {
          const inMonth = isSameMonth(day, anchor);
          const isToday = isSameDay(day, today);
          const isSelected = selectedDay != null && isSameDay(day, selectedDay);
          const dayEvents = byDay.get(keyOf(day)) ?? [];
          return (
            <DroppableCell
              key={day.toISOString()}
              id={monthCellId(dayIso(day))}
              onClick={() => onDayOpen?.(day)}
              ariaLabel={`${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日，${dayEvents.length} 個事件`}
              className={cn(
                "group flex min-h-[92px] cursor-pointer flex-col gap-1.5 border-b border-r border-border p-2 align-top transition-colors hover:bg-accent/50",
                !inMonth && "bg-muted/20 text-muted-foreground",
                index % 7 >= 5 && inMonth && "bg-muted/10",
                isSelected && "bg-accent/60 ring-1 ring-inset ring-ring",
              )}
            >
              <div className="flex h-7 items-center justify-between gap-1">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDayOpen?.(day);
                  }}
                  title={dayEvents.length > 0 ? `查看 ${day.getMonth() + 1}月${day.getDate()}日的 ${dayEvents.length} 個行程` : `查看 ${day.getMonth() + 1}月${day.getDate()}日`}
                  aria-label={`查看 ${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日的完整行程（${dayEvents.length} 個）`}
                  className={cn(
                    "inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-sm tabular-nums transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    !inMonth && "opacity-60",
                    isToday
                      ? "bg-primary font-semibold text-primary-foreground shadow-sm hover:opacity-90"
                      : "hover:bg-background hover:shadow-sm",
                  )}
                >
                  {day.getDate()}
                </button>
                {dayEvents.length > 0 && (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                    {dayEvents.length}
                  </span>
                )}
              </div>
              <div className="flex min-h-0 flex-col gap-1 overflow-hidden">
                {dayEvents.slice(0, 3).map((occurrence) => (
                  <DraggableChip
                    key={`${occurrence.event_id}-${occurrence.occurrence_start_utc}`}
                    occ={occurrence}
                    title={occurrence.source === "agent" ? `${occurrence.title}（AI 助理排程）` : occurrence.title}
                    onClick={(event) => {
                      event.stopPropagation();
                      onEventClick?.(occurrence);
                    }}
                    className={cn(
                      "flex min-h-6 w-full items-center gap-1.5 truncate rounded-md border border-transparent px-1.5 py-1 text-left text-xs leading-none transition-colors",
                      occurrence.source === "agent"
                        ? "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300 font-medium hover:bg-violet-500/15"
                        : occurrence.is_exception
                          ? "border-border bg-accent text-accent-foreground font-medium"
                          : "border-primary/20 bg-primary/10 text-primary font-medium hover:bg-primary/20 hover:border-primary/30",
                    )}
                  >
                    {occurrence.source === "agent" && <Sparkles className="h-3 w-3 shrink-0 text-violet-500" aria-label="AI 助理排程" />}
                    <span className="truncate tabular-nums">
                      {fmtTime(occurrence.occurrence_start_utc, tz)} {occurrence.title}
                    </span>
                  </DraggableChip>
                ))}
                {dayEvents.length > 3 && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDayOpen?.(day);
                    }}
                    className="mt-0.5 w-full rounded-md px-1.5 py-0.5 text-left text-xs font-medium text-primary underline-offset-2 transition-colors hover:bg-primary/10 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    aria-label={`查看 ${day.getMonth() + 1}月${day.getDate()}日的全部 ${dayEvents.length} 個行程`}
                    title={dayEvents.slice(3).map((event) => event.title).join("、")}
                  >
                    還有 {dayEvents.length - 3} 個，查看全部
                  </button>
                )}
              </div>
            </DroppableCell>
          );
        })}
      </div>
    </div>
  );
}
