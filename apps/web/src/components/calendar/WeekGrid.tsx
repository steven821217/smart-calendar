import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import { weekGridDays, isSameDay, nowInViewer } from "@/lib/calendar";
import { utcToViewer, minutesFromMidnight, durationMinutes, fmtTime } from "@/lib/time";
import { weekSlotId } from "@/lib/drag";
import { DraggableChip, DroppableCell } from "@/components/calendar/dragParts";
import type { Occurrence } from "@/lib/api";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const HOUR_PX = 48;
const SLOT_MIN = 30; // droppable 時段粒度（落點 snap 到 30 分；細部由 snap15 處理）
const SLOTS_PER_DAY = (24 * 60) / SLOT_MIN;
const DAY_MINUTES = 24 * 60;

interface Props {
  anchor: Date;
  tz: string;
  occurrences: Occurrence[];
  onEventClick?: (occ: Occurrence) => void;
}

interface Positioned {
  occ: Occurrence;
  top: number;
  height: number;
  col: number;
  cols: number;
}

function dayIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}T00:00`;
}

/** 週視圖：時間軸 + 事件分鐘 offset 定位 + 半小時 droppable 時段（UI-17/21）。 */
export function WeekGrid({ anchor, tz, occurrences, onEventClick }: Props) {
  const days = useMemo(() => weekGridDays(anchor), [anchor]);
  const today = useMemo(() => nowInViewer(tz), [tz]);

  const perDay = useMemo(() => {
    return days.map((day) => {
      const dayOccs = occurrences
        .filter((o) => isSameDay(utcToViewer(o.occurrence_start_utc, tz), day))
        .sort(
          (a, b) =>
            new Date(a.occurrence_start_utc).getTime() -
            new Date(b.occurrence_start_utc).getTime(),
        );
      return packColumns(dayOccs, tz);
    });
  }, [days, occurrences, tz]);

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="sticky top-0 z-10 grid grid-cols-[3rem_repeat(7,1fr)] border-b border-border bg-background">
        <div />
        {days.map((d) => (
          <div
            key={d.toISOString()}
            className={cn(
              "px-2 py-2 text-center text-xs",
              isSameDay(d, today) ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            週{WEEKDAYS[(d.getDay() + 6) % 7]} {d.getDate()}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-[3rem_repeat(7,1fr)]" style={{ height: HOUR_PX * 24 }}>
        <div className="relative">
          {Array.from({ length: 24 }, (_, h) => (
            <div
              key={h}
              className="absolute right-1 -translate-y-1/2 text-[10px] text-muted-foreground"
              style={{ top: h * HOUR_PX }}
            >
              {String(h).padStart(2, "0")}:00
            </div>
          ))}
        </div>
        {perDay.map((positioned, i) => (
          <div key={days[i].toISOString()} className="relative border-l border-border">
            {/* 半小時 droppable 時段（承接落點）；置底，事件在其上 */}
            {Array.from({ length: SLOTS_PER_DAY }, (_, s) => (
              <DroppableCell
                key={s}
                id={weekSlotId(dayIso(days[i]), s * SLOT_MIN)}
                className="absolute inset-x-0"
                style={{ top: ((s * SLOT_MIN) / 60) * HOUR_PX, height: (SLOT_MIN / 60) * HOUR_PX }}
              >
                <div className="h-full border-t border-border/40" />
              </DroppableCell>
            ))}
            {positioned.map((p) => (
              <DraggableChip
                key={`${p.occ.event_id}-${p.occ.occurrence_start_utc}`}
                occ={p.occ}
                title={p.occ.title}
                onClick={() => onEventClick?.(p.occ)}
                style={{
                  position: "absolute",
                  top: p.top,
                  height: Math.max(p.height, 16),
                  left: `${(p.col / p.cols) * 100}%`,
                  width: `${(1 / p.cols) * 100}%`,
                  zIndex: 1,
                }}
                className={cn(
                  "overflow-hidden rounded px-1 py-0.5 text-left text-[11px] leading-tight border",
                  p.occ.source === "agent"
                    ? "bg-violet-500/15 text-foreground border-violet-500/30 hover:bg-violet-500/25"
                    : p.occ.is_exception
                      ? "bg-accent text-accent-foreground border-primary/20 hover:bg-primary/25"
                      : "bg-primary/15 text-foreground border-primary/20 hover:bg-primary/25",
                )}
              >
                <div className="flex items-center gap-1 truncate font-medium">
                  {p.occ.source === "agent" && (
                    <Sparkles className="h-2.5 w-2.5 shrink-0 text-violet-500" aria-label="AI 助理排程" />
                  )}
                  <span className="truncate">{p.occ.title}</span>
                </div>
                <div className="truncate text-muted-foreground">
                  {fmtTime(p.occ.occurrence_start_utc, tz)}
                </div>
              </DraggableChip>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function packColumns(occs: Occurrence[], tz: string): Positioned[] {
  const items = occs.map((occ) => {
    const startMin = minutesFromMidnight(occ.occurrence_start_utc, tz);
    const dur = durationMinutes(occ.occurrence_start_utc, occ.occurrence_end_utc);
    return {
      occ,
      startMin,
      endMin: Math.min(startMin + dur, DAY_MINUTES),
      top: (startMin / 60) * HOUR_PX,
      height: (dur / 60) * HOUR_PX,
      col: 0,
      cols: 1,
    };
  });

  let clusterEnd = -1;
  let cluster: typeof items = [];
  const flush = () => {
    const cols: number[] = [];
    for (const it of cluster) {
      let placed = false;
      for (let c = 0; c < cols.length; c++) {
        if (it.startMin >= cols[c]) {
          it.col = c;
          cols[c] = it.endMin;
          placed = true;
          break;
        }
      }
      if (!placed) {
        it.col = cols.length;
        cols.push(it.endMin);
      }
    }
    for (const it of cluster) it.cols = cols.length;
    cluster = [];
  };

  for (const it of items) {
    if (cluster.length && it.startMin >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  if (cluster.length) flush();

  return items.map(({ occ, top, height, col, cols }) => ({ occ, top, height, col, cols }));
}
