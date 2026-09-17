import { useMemo } from "react";
import { Plus, Sparkles } from "lucide-react";
import { monthGridDays, isSameDay, isSameMonth, nowInViewer } from "@/lib/calendar";
import { utcToViewer, fmtTime } from "@/lib/time";
import { monthCellId } from "@/lib/drag";
import { DraggableChip, DroppableCell } from "@/components/calendar/dragParts";
import type { Occurrence } from "@/lib/api";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

interface Props {
  anchor: Date; // 觀看者時區的月份錨點
  tz: string;
  occurrences: Occurrence[];
  selectedDay?: Date | null;
  onDayClick?: (day: Date) => void;
  onDayCreate?: (day: Date) => void;
  onEventClick?: (occ: Occurrence) => void;
}

/** 本地日期 → 該日 00:00 的 ISO（yyyy-MM-ddT00:00，供 drop 落點解碼）。 */
function dayIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}T00:00`;
}

/** 月視圖：grid-cols-7 auto-rows-fr，42 格；非本月淡化、今天高亮（UI-17）。 */
export function MonthGrid({ anchor, tz, occurrences, selectedDay, onDayClick, onDayCreate, onEventClick }: Props) {
  const days = useMemo(() => monthGridDays(anchor), [anchor]);
  const today = useMemo(() => nowInViewer(tz), [tz]);

  const byDay = useMemo(() => {
    const m = new Map<string, Occurrence[]>();
    for (const o of occurrences) {
      const z = utcToViewer(o.occurrence_start_utc, tz);
      const key = `${z.getFullYear()}-${z.getMonth()}-${z.getDate()}`;
      (m.get(key) ?? m.set(key, []).get(key)!).push(o);
    }
    return m;
  }, [occurrences, tz]);

  const keyOf = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-7 border-b border-border text-xs text-muted-foreground">
        {WEEKDAYS.map((w) => (
          <div key={w} className="px-2 py-2 text-center font-medium">
            {w}
          </div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-7 auto-rows-fr">
        {days.map((d) => {
          const inMonth = isSameMonth(d, anchor);
          const isToday = isSameDay(d, today);
          const isSelected = selectedDay != null && isSameDay(d, selectedDay);
          const dayEvents = byDay.get(keyOf(d)) ?? [];
          return (
            <DroppableCell
              key={d.toISOString()}
              id={monthCellId(dayIso(d))}
              onClick={() => onDayClick?.(d)}
              ariaLabel={`${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`}
              className={cn(
                "flex min-h-[96px] cursor-pointer flex-col gap-1 border-b border-r border-border p-1.5 align-top transition-colors hover:bg-accent/50",
                !inMonth && "bg-muted/30 text-muted-foreground",
                isSelected && "bg-accent/40 ring-2 ring-inset ring-primary",
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs",
                    isToday && "bg-primary text-primary-foreground font-semibold",
                  )}
                >
                  {d.getDate()}
                </span>
                {isSelected && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDayCreate?.(d);
                    }}
                    className="inline-flex h-5 w-5 items-center justify-center rounded bg-primary text-primary-foreground hover:opacity-90"
                    aria-label={`在 ${d.getMonth() + 1}月${d.getDate()}日 建立事件`}
                    title="建立事件"
                  >
                    <Plus className="h-3 w-3" aria-hidden />
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-0.5 overflow-hidden">
                {dayEvents.slice(0, 3).map((o) => (
                  <DraggableChip
                    key={`${o.event_id}-${o.occurrence_start_utc}`}
                    occ={o}
                    title={o.source === "agent" ? `${o.title}（AI 助理排程）` : o.title}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick?.(o);
                    }}
                    className={cn(
                      "flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] leading-tight",
                      o.source === "agent"
                        ? "bg-violet-500/15 text-foreground ring-1 ring-inset ring-violet-500/30"
                        : o.is_exception
                          ? "bg-accent"
                          : "bg-primary/10 text-foreground",
                    )}
                  >
                    {o.source === "agent" && (
                      <Sparkles className="h-2.5 w-2.5 shrink-0 text-violet-500" aria-label="AI 助理排程" />
                    )}
                    <span className="truncate">
                      {fmtTime(o.occurrence_start_utc, tz)} {o.title}
                    </span>
                  </DraggableChip>
                ))}
                {dayEvents.length > 3 && (
                  <span className="px-1 text-[10px] text-muted-foreground">
                    +{dayEvents.length - 3} 更多
                  </span>
                )}
              </div>
            </DroppableCell>
          );
        })}
      </div>
    </div>
  );
}
