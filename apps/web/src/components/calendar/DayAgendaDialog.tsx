import { useEffect, useMemo, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { CalendarDays, Plus, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtTime, utcToViewer, durationMinutes } from "@/lib/time";
import { isSameDay } from "@/lib/calendar";
import type { Occurrence } from "@/lib/api";
import { cn } from "@/lib/utils";

const WEEKDAY_LABELS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

/**
 * 當日行程彈窗：月視圖每格僅能容納少數事件，點日期即在此列出「該日全部行程」，
 * 解決單日事件超過格子高度時看不到後續事件的問題。
 * 事實資料沿用月視圖已取得的 occurrences（同一查詢窗口），不額外打 API。
 */
export function DayAgendaDialog({
  day,
  tz,
  occurrences,
  onClose,
  onCreate,
  onEventClick,
}: {
  day: Date;
  tz: string;
  /** 該日全部 occurrences（未排序亦可）。 */
  occurrences: Occurrence[];
  onClose: () => void;
  onCreate: (day: Date) => void;
  onEventClick: (occ: Occurrence) => void;
}) {
  const reduce = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 開啟時把焦點移入對話框，關閉後歸還給原本的觸發元素（鍵盤操作不迷路）。
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  // Escape 關閉；Tab 在對話框內循環（focus trap）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const sorted = useMemo(
    () => [...occurrences].sort((a, b) => a.occurrence_start_utc.localeCompare(b.occurrence_start_utc)),
    [occurrences],
  );

  const headingId = "day-agenda-heading";
  const dateLabel = `${day.getFullYear()} 年 ${day.getMonth() + 1} 月 ${day.getDate()} 日`;
  const weekdayLabel = WEEKDAY_LABELS[day.getDay()];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onClick={onClose}
    >
      <motion.div
        ref={panelRef}
        initial={reduce ? false : { opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-t-xl border border-border bg-card shadow-xl sm:max-h-[80vh] sm:rounded-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3 sm:px-5">
          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <CalendarDays className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={headingId} className="truncate text-base font-semibold tracking-tight">
              {dateLabel}（{weekdayLabel}）
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {sorted.length > 0 ? `共 ${sorted.length} 個行程 · 時間為 ${tz}` : `這天還沒有行程 · 時間為 ${tz}`}
            </p>
          </div>
          <Button ref={closeRef} variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} aria-label="關閉當日行程">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5" data-wheel-native="vertical">
          {sorted.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">這天沒有任何行程，可直接在下方建立。</p>
          ) : (
            <ul className="space-y-2">
              {sorted.map((occurrence) => {
                const endsOnAnotherDay = !isSameDay(utcToViewer(occurrence.occurrence_end_utc, tz), day);
                const minutes = Math.max(0, Math.round(durationMinutes(occurrence.occurrence_start_utc, occurrence.occurrence_end_utc)));
                return (
                  <li key={`${occurrence.event_id}-${occurrence.occurrence_start_utc}`}>
                    <button
                      type="button"
                      onClick={() => onEventClick(occurrence)}
                      className={cn(
                        "flex w-full min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                        occurrence.source === "agent"
                          ? "border-violet-500/25 bg-violet-500/5 hover:bg-violet-500/10"
                          : "border-border bg-background hover:bg-accent/50",
                      )}
                    >
                      <span className="w-[86px] shrink-0 text-sm font-medium tabular-nums">
                        {fmtTime(occurrence.occurrence_start_utc, tz)}
                        <span className="block text-xs font-normal text-muted-foreground">
                          {fmtTime(occurrence.occurrence_end_utc, tz)}
                          {endsOnAnotherDay && " 次日"}
                        </span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          {occurrence.source === "agent" && (
                            <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-500" aria-label="AI 助理排程" />
                          )}
                          <span className="truncate text-sm font-medium" title={occurrence.title}>
                            {occurrence.title}
                          </span>
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span>{minutes >= 60 ? `${Math.floor(minutes / 60)} 小時${minutes % 60 ? ` ${minutes % 60} 分` : ""}` : `${minutes} 分鐘`}</span>
                          {occurrence.is_exception && (
                            <span className="rounded-full bg-muted px-2 py-0.5">單次調整</span>
                          )}
                          {occurrence.source === "agent" && (
                            <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-violet-600 dark:text-violet-300">AI 助理排程</span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-muted/20 px-4 py-3 sm:flex-row sm:justify-end sm:px-5">
          <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={onClose}>
            關閉
          </Button>
          <Button size="sm" className="w-full sm:w-auto" onClick={() => onCreate(day)}>
            <Plus className="h-4 w-4" aria-hidden />
            在這天建立事件
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
