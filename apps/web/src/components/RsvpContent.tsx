import { useState } from "react";
import { Calendar, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/feedback";
import { api, ApiError } from "@/lib/api";

export interface RsvpContentProps {
  eventId: string;
  token: string;
  /** 回覆成功後回呼（App 內用來 invalidate 收件匣、關閉彈窗等）。 */
  onResponded?: (status: "accepted" | "declined") => void;
}

/**
 * RSVP 內容（邏輯 + 內層 UI），不含外框容器。
 * 同時被兩處複用：
 *  - RsvpPage：外部通知深連結（#/rsvp?event=&token=）的免登入整頁
 *  - RsvpDialog：App 內收件匣點項目時的當前頁彈窗（不跳頁）
 */
export function RsvpContent({ eventId, token, onResponded }: RsvpContentProps) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"accepted" | "declined" | null>(null);
  const [eventInfo, setEventInfo] = useState<{
    title: string;
    start_utc: string;
    end_utc: string;
    timezone: string;
    location: string | null;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const missing = !eventId || !token;

  async function respond(decision: "accept" | "decline") {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.rsvp(eventId, token, decision);
      const status = r.rsvp_status as "accepted" | "declined";
      setDone(status);
      if (r.event) setEventInfo(r.event);
      onResponded?.(status);
    } catch (e) {
      setErr(e instanceof ApiError ? (e.detail ?? e.title) : "回覆失敗，連結可能已失效");
    } finally {
      setBusy(false);
    }
  }

  const fmtRange = (info: NonNullable<typeof eventInfo>) => {
    const d = new Intl.DateTimeFormat("zh-TW", { dateStyle: "full", timeZone: info.timezone }).format(
      new Date(info.start_utc),
    );
    const t = (iso: string) =>
      new Intl.DateTimeFormat("zh-TW", { timeStyle: "short", timeZone: info.timezone }).format(new Date(iso));
    return `${d} ${t(info.start_utc)}–${t(info.end_utc)}`;
  };

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <Calendar className="h-5 w-5" aria-hidden />
        <h1 className="text-lg font-semibold">會議邀請回覆</h1>
      </div>

      {missing ? (
        <p className="text-sm text-muted-foreground">缺少邀請資訊。請使用通知中的完整連結開啟本頁。</p>
      ) : done ? (
        <div className="space-y-3 text-sm">
          <div
            className={
              done === "accepted"
                ? "flex items-center gap-2 text-emerald-600"
                : "flex items-center gap-2 text-muted-foreground"
            }
          >
            {done === "accepted" ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
            {done === "accepted" ? "已接受，事件已排入你的行事曆。" : "已婉拒此邀請。"}
          </div>
          {eventInfo && (
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="font-medium">{eventInfo.title}</div>
              <div className="mt-1 text-xs text-muted-foreground">{fmtRange(eventInfo)}</div>
              {eventInfo.location && (
                <div className="mt-0.5 text-xs text-muted-foreground">📍 {eventInfo.location}</div>
              )}
              <div className="mt-1 text-xs text-muted-foreground">
                時間依此事件時區（{eventInfo.timezone}）顯示
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            你的團隊 Leader 透過 AI 助理幫你安排了一個事件。請選擇是否接受，接受後才會正式排入行事曆。
          </p>
          {err && (
            <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {err}
            </div>
          )}
          <div className="flex gap-2">
            <Button onClick={() => respond("accept")} disabled={busy}>
              {busy ? <Spinner /> : <Check className="h-4 w-4" aria-hidden />}
              接受
            </Button>
            <Button variant="outline" onClick={() => respond("decline")} disabled={busy}>
              <X className="h-4 w-4" aria-hidden />
              婉拒
            </Button>
          </div>
        </>
      )}
    </>
  );
}
