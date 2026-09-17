import { RsvpContent } from "@/components/RsvpContent";

/**
 * RSVP 頁（feature-team-groups Req 3.2）——外部通知深連結入口。
 * Member 從 email / webhook 通知點進來的免登入整頁：URL 帶 event + rsvp_token，
 * token 自證身份即可 accept / decline。進入路徑：#/rsvp?event=<eventId>&token=<rsvp_token>
 *
 * ⚠️ App 內收件匣點項目時走 RsvpDialog（當前頁彈窗，不跳頁），不是這頁。
 */
export function RsvpPage() {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const eventId = params.get("event") ?? "";
  const token = params.get("token") ?? "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-md rounded-xl border border-border p-6 shadow-sm">
        <RsvpContent eventId={eventId} token={token} />
      </div>
    </div>
  );
}
