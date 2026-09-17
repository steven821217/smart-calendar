import { useState, type FormEvent } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, type EventDraft } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/feedback";

/**
 * NLQuickAdd（9.5, REQ-S3 / UI）：自然語言 → 草稿。
 * 呼叫 POST /v1/events/parse（規則式 parser），拿到草稿後交給上層開啟建立表單（一鍵確認）。
 * 低信心或有 warnings 時提示使用者確認欄位。
 */
export function NLQuickAdd({
  tz,
  onDraft,
}: {
  tz: string;
  onDraft: (draft: EventDraft) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const { draft } = await api.parseText(t, tz, new Date().toISOString());
      if (draft.warnings.length) {
        toast.warning("草稿已建立，請確認欄位", { description: draft.warnings.join("；") });
      } else if (draft.confidence < 0.6) {
        toast.info("草稿信心較低，請確認時間與標題");
      }
      onDraft(draft);
      setText("");
    } catch (err) {
      toast.error(err instanceof ApiError ? (err.detail ?? err.title) : "解析失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-1.5">
      <div className="relative">
        <Sparkles
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="快速輸入：明天下午2點 團隊會議"
          aria-label="自然語言快速建立事件"
          className="h-8 w-56 pl-7 text-xs"
          disabled={busy}
        />
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={busy || !text.trim()}>
        {busy ? <Spinner /> : "解析"}
      </Button>
    </form>
  );
}
