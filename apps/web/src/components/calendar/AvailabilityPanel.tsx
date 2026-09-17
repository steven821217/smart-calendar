import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { api, type AvailabilitySlot } from "@/lib/api";
import { fmtTime } from "@/lib/time";
import { Skeleton } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";

/**
 * 空檔建議卡片（9.5, REQ-S1）。查 GET /v1/availability，
 * 對指定日 + 時長回避開忙碌的候選時段，點擊套用到事件表單。
 * 僅反映 free/busy，不洩漏事件內容（UI-6）。
 */
export function AvailabilityPanel({
  dayUtcFrom,
  dayUtcTo,
  durationMinutes,
  tz,
  workspaceId,
  onPick,
}: {
  dayUtcFrom: string; // 查詢窗口起（UTC ISO）
  dayUtcTo: string;
  durationMinutes: number;
  tz: string;
  workspaceId: string;
  onPick: (slot: AvailabilitySlot) => void;
}) {
  const enabled = durationMinutes > 0 && !!dayUtcFrom && !!dayUtcTo;
  const { data, isLoading, isError } = useQuery({
    queryKey: ["availability", workspaceId, dayUtcFrom, dayUtcTo, durationMinutes],
    queryFn: () => api.availability(dayUtcFrom, dayUtcTo, durationMinutes),
    enabled,
  });

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <CalendarClock className="h-4 w-4" aria-hidden />
        建議時段
        <span className="text-xs font-normal text-muted-foreground">（避開當日忙碌）</span>
      </div>

      {!enabled ? (
        <p className="text-xs text-muted-foreground">請先設定開始/結束以取得時長。</p>
      ) : isLoading ? (
        <div className="flex gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-20" />
          ))}
        </div>
      ) : isError ? (
        <p className="text-xs text-destructive">無法取得建議時段。</p>
      ) : !data?.slots.length ? (
        <p className="text-xs text-muted-foreground">當日無可用空檔。</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {data.slots.map((s) => (
            <button
              key={s.start_utc}
              type="button"
              onClick={() => onPick(s)}
              className={cn(
                "rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-accent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              title={`分數 ${s.score ?? "—"}`}
            >
              {fmtTime(s.start_utc, tz)}–{fmtTime(s.end_utc, tz)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
