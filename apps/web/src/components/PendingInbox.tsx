import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/store/auth";
import { RsvpDialog } from "@/components/RsvpDialog";
import { cn } from "@/lib/utils";

/**
 * PendingInbox（UX #3 待處理收件匣）：
 * 登入使用者作為 member、尚未回覆的 pending 邀請（多半由 AI 助理幫 Leader 排）。
 * SSE 即時推播為主、輪詢為備援。點項目在「當前頁彈窗」回覆（RsvpDialog），不跳頁。
 */
export function PendingInbox() {
  const me = useAuth((s) => s.me);
  const tz = me?.timezone ?? "UTC";
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<{ eventId: string; token: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    // per-member key：同 workspace 內切帳號（如 leader→member）也要重抓，
    // 否則會沿用前一位使用者的收件匣快取。
    queryKey: ["pending-rsvps", me?.workspace.id, me?.membership_id],
    queryFn: () => api.listPendingRsvps(),
    refetchInterval: 60_000, // SSE 即時推播為主；輪詢僅作斷線備援
    refetchOnWindowFocus: true,
    enabled: !!me,
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pending = data?.pending ?? [];
  const count = pending.length;

  const fmt = (iso: string, timezone: string) =>
    new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(
      new Date(iso),
    );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`待處理邀請${count ? `（${count}）` : ""}`}
        title="待你回覆的邀請"
      >
        <Bell className="h-4 w-4" aria-hidden />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-xs font-semibold text-destructive-foreground">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="待處理邀請"
          className="absolute right-0 top-full z-30 mt-1 w-80 rounded-lg border border-border bg-popover p-2 shadow-lg"
        >
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            待你回覆的邀請{count ? `（${count}）` : ""}
          </div>
          {count === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">目前沒有待處理的邀請 🎉</div>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-auto">
              {pending.map((p) => (
                <li key={p.event_id}>
                  <button
                    type="button"
                    onClick={() => {
                      setActive({ eventId: p.event_id, token: p.rsvp_token });
                      setOpen(false);
                    }}
                    className={cn("block w-full rounded-md px-2 py-2 text-left text-sm hover:bg-accent")}
                  >
                    <div className="font-medium">{p.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{fmt(p.start_utc, tz)}</div>
                    {p.location && <div className="text-xs text-muted-foreground">📍 {p.location}</div>}
                    <div className="mt-1 text-xs text-violet-500">✨ AI 助理幫你安排，點此接受或婉拒</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {active && (
        <RsvpDialog
          eventId={active.eventId}
          token={active.token}
          onClose={() => setActive(null)}
          onResponded={() => {
            // 回覆後刷新收件匣與相關清單（pending 該筆會消失）
            qc.invalidateQueries({ queryKey: ["pending-rsvps"] });
            qc.invalidateQueries({ queryKey: ["recent-events"] });
            qc.invalidateQueries({ queryKey: ["occurrences"] });
          }}
        />
      )}
    </div>
  );
}
