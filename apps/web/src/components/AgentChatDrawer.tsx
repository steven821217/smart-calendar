import { useRef, useState, type FormEvent } from "react";
import { Bot, Send, X, Sparkles } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/store/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";

interface Msg {
  role: "user" | "agent";
  text: string;
  kind?: string;
  optionToken?: string; // needs_decision 時，供「確認排入」按鈕
}

const SUGGESTIONS = ["明天有會議嗎？", "這週有幾個會？", "明天下午有空嗎？", "有沒有待我回覆的邀請？"];

/**
 * 站內對話 agent 抽屜（B 方案）。打 POST /v1/agent/chat：能查詢（今天/明天有什麼、
 * 幾個會、有沒有空、待回覆）也能排會（轉委員會）。時間由後端規則算、答案模板化，
 * 對 14B local model 穩健。
 */
export function AgentChatDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useAuth((s) => s.me);
  const tz = me?.timezone ?? "Asia/Taipei";
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "agent", text: "嗨，我可以幫你查行程或安排會議。試試下面的問題，或直接輸入。" },
  ]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setMsgs((m) => [...m, { role: "user", text: question }]);
    setText("");
    setBusy(true);
    try {
      const r = await api.agentChat(question, tz);
      setMsgs((m) => [...m, { role: "agent", text: r.message, kind: r.kind, optionToken: r.data?.option_token }]);
    } catch (e) {
      setMsgs((m) => [
        ...m,
        { role: "agent", text: e instanceof ApiError ? (e.detail ?? e.title) : "發生錯誤，請再試一次。", kind: "error" },
      ]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }));
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(text);
  };

  async function confirm(token: string) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.agentConfirm(token);
      setMsgs((m) => [...m, { role: "agent", text: r.message, kind: r.kind }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "agent", text: e instanceof ApiError ? (e.detail ?? e.title) : "確認失敗。", kind: "error" }]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-label="日曆助理">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-violet-500" aria-hidden />
            <span className="font-semibold">日曆助理</span>
            <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-600">本地 AI</span>
          </div>
          <button onClick={onClose} aria-label="關閉" className="rounded-md p-1 hover:bg-accent">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div ref={listRef} className="flex-1 space-y-3 overflow-auto p-4">
          {msgs.map((m, i) => (
            <div key={i} className={cn("flex flex-col", m.role === "user" ? "items-end" : "items-start")}>
              <div
                className={cn(
                  "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm",
                  m.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : m.kind === "error"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-muted text-foreground",
                )}
              >
                {m.text}
              </div>
              {m.optionToken && (
                <Button size="sm" className="mt-1.5" disabled={busy} onClick={() => confirm(m.optionToken!)}>
                  確認排入行事曆
                </Button>
              )}
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground">
                <Spinner /> 思考中…
              </div>
            </div>
          )}
        </div>

        {/* 建議問題 */}
        <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => ask(s)}
              disabled={busy}
              className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent"
            >
              {s}
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-border p-3">
          <div className="relative flex-1">
            <Sparkles className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="問行程，或說「幫我約明天下午開會」"
              aria-label="與日曆助理對話"
              className="pl-7"
              disabled={busy}
            />
          </div>
          <Button type="submit" size="icon" disabled={busy || !text.trim()} aria-label="送出">
            <Send className="h-4 w-4" aria-hidden />
          </Button>
        </form>
      </aside>
    </div>
  );
}
