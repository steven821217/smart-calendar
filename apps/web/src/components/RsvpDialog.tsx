import { X } from "lucide-react";
import { RsvpContent } from "@/components/RsvpContent";

interface Props {
  eventId: string;
  token: string;
  onClose: () => void;
  onResponded?: (status: "accepted" | "declined") => void;
}

/**
 * RSVP 彈窗（App 內收件匣用）：點收件匣項目時在當前頁開此 modal 回覆，
 * 不跳轉到 #/rsvp 整頁。回覆完關閉並由呼叫端刷新收件匣。
 * 樣式對齊 EventDialog 的 overlay。
 */
export function RsvpDialog({ eventId, token, onClose, onResponded }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-label="會議邀請回覆"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="關閉"
          className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
        <RsvpContent eventId={eventId} token={token} onResponded={onResponded} />
      </div>
    </div>
  );
}
