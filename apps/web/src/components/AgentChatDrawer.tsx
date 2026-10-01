import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Bot, Send, X, Sparkles, RotateCcw, CalendarClock } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/store/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/feedback";
import { fmt, fmtTime } from "@/lib/time";
import { cn } from "@/lib/utils";

interface AgentOccurrence {
  occurrence_start_utc: string;
  occurrence_end_utc: string;
  title: string;
  source?: string;
}
interface AgentSlot {
  start_utc: string;
  end_utc: string;
}

interface Msg {
  role: "user" | "agent";
  text: string;
  kind?: string;
  /** 排會預覽 → 一鍵確認排入（POST /v1/agent/confirm）。 */
  optionToken?: string;
  /** 破壞性動作（改期/取消/回覆邀請）預覽 → 第二步確認（POST /v1/agent/confirm-action）。 */
  actionToken?: string;
  /** 觸發此動作的意圖，用來決定確認鈕的措辭與是否為破壞性樣式。 */
  intent?: string;
  /** 後端算好的結構化結果，用來渲染可讀的事件/空檔卡片（事實仍以文字訊息為準）。 */
  events?: AgentOccurrence[];
  slots?: AgentSlot[];
  /** token 已用掉（或使用者選擇不執行）→ 不再顯示確認鈕，避免重複送出。 */
  resolved?: boolean;
}

const SUGGESTIONS = ["明天有會議嗎？", "這週有幾個會？", "明天下午有空嗎？", "有沒有待我回覆的邀請？"];

/** 破壞性意圖：確認鈕用紅色，並額外提供「先不要」讓使用者安全退出。 */
const DESTRUCTIVE = new Set(["cancel", "reschedule"]);

function confirmLabelFor(intent?: string): string {
  if (intent === "cancel") return "確認取消這個行程";
  if (intent === "reschedule") return "確認改期";
  if (intent === "respond_rsvp") return "確認回覆";
  return "確認執行";
}

/**
 * 站內對話 agent 抽屜（B 方案）。打 POST /v1/agent/chat：能查詢（今天/明天有什麼、
 * 幾個會、有沒有空、待回覆）也能排會（轉委員會），並支援改期/取消/回覆邀請的兩步確認。
 * 時間由後端規則算、答案模板化，對 14B local model 穩健。
 */
export function AgentChatDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useAuth((s) => s.me);
  const tz = me?.timezone ?? "Asia/Taipei";
  const qc = useQueryClient();
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "agent", text: "嗨，我可以幫你查行程或安排會議。試試下面的問題，或直接輸入。" },
  ]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  /** 最後一個失敗的問題：供「重試」按鈕重送，不必使用者重打。 */
  const [failed, setFailed] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 開啟前的焦點元素，關閉時歸還焦點（鍵盤/讀屏使用者不會迷失位置）。 */
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const prevOpenRef = useRef(false);

  // 在「關閉→開啟」這次 render 就記下原焦點：此時抽屜子樹尚未 commit，
  // document.activeElement 還是觸發按鈕。若改用 effect 記錄，Input 的 autoFocus
  // 已在 commit 階段搶先聚焦，會誤記成輸入框本身，導致關閉後焦點掉到 body。
  if (open && !prevOpenRef.current) {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
  }
  prevOpenRef.current = open;

  // 關閉時把焦點歸還給開啟前的元素。開啟時的聚焦交給 Input 的 autoFocus：
  // 抽屜關閉時整棵子樹卸載，每次開啟都是重新掛載，由瀏覽器在掛載時聚焦最可靠
  //（用 requestAnimationFrame 自行聚焦會與 React commit 競態，實測會出現焦點
  // 仍留在觸發按鈕上的情形）。
  useEffect(() => {
    if (!open) returnFocusRef.current?.focus?.();
  }, [open]);

  // Escape 關閉（與其他對話框一致的鍵盤預期）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const scrollToEnd = () =>
    requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }));

  /** 最新一則 agent 訊息：交給 aria-live 播報，讀屏使用者才知道答案到了。 */
  const lastAgentText = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "agent") return msgs[i].text;
    return "";
  }, [msgs]);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setMsgs((m) => [...m, { role: "user", text: question }]);
    setText("");
    setFailed(null);
    setBusy(true);
    scrollToEnd();
    try {
      const r = await api.agentChat(question, tz);
      const data = (r.data ?? {}) as Record<string, unknown>;
      setMsgs((m) => [
        ...m,
        {
          role: "agent",
          text: r.message,
          kind: r.kind,
          intent: r.intent,
          optionToken: typeof data.option_token === "string" ? data.option_token : undefined,
          actionToken: typeof data.action_token === "string" ? data.action_token : undefined,
          events: Array.isArray(data.events) ? (data.events as AgentOccurrence[]) : undefined,
          slots: Array.isArray(data.slots) ? (data.slots as AgentSlot[]) : undefined,
        },
      ]);
    } catch (e) {
      setFailed(question);
      setMsgs((m) => [
        ...m,
        { role: "agent", text: e instanceof ApiError ? (e.detail ?? e.title) : "發生錯誤，請再試一次。", kind: "error" },
      ]);
    } finally {
      setBusy(false);
      scrollToEnd();
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(text);
  };

  /** 標記某則訊息的 token 已處理，確認鈕即消失（防重複送出）。 */
  const resolveAt = (idx: number) =>
    setMsgs((m) => m.map((msg, i) => (i === idx ? { ...msg, resolved: true } : msg)));

  /** 排會預覽 → 落實（option_token）。 */
  async function confirmSchedule(idx: number, token: string) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.agentConfirm(token);
      resolveAt(idx);
      setMsgs((m) => [...m, { role: "agent", text: r.message, kind: r.kind }]);
      await qc.invalidateQueries();
    } catch (e) {
      setMsgs((m) => [...m, { role: "agent", text: e instanceof ApiError ? (e.detail ?? e.title) : "確認失敗。", kind: "error" }]);
    } finally {
      setBusy(false);
      scrollToEnd();
    }
  }

  /** 破壞性動作預覽 → 落實（action_token）。 */
  async function confirmAction(idx: number, token: string) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.agentConfirmAction(token, tz);
      resolveAt(idx);
      setMsgs((m) => [...m, { role: "agent", text: r.message, kind: r.kind }]);
      // 改期/取消會動到日曆本身：主動失效快取，不必等 SSE 或輪詢。
      await qc.invalidateQueries();
    } catch (e) {
      setMsgs((m) => [...m, { role: "agent", text: e instanceof ApiError ? (e.detail ?? e.title) : "執行失敗。", kind: "error" }]);
    } finally {
      setBusy(false);
      scrollToEnd();
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="日曆助理">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-violet-500" aria-hidden />
            <span className="font-semibold">日曆助理</span>
            <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-xs text-violet-600 dark:text-violet-300">本地 AI</span>
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
                      : m.kind === "needs_confirmation"
                        ? "bg-amber-500/10 text-foreground"
                        : m.kind === "not_permitted"
                          ? "bg-muted text-muted-foreground"
                          : "bg-muted text-foreground",
                )}
              >
                {m.text}
              </div>

              {/* 結構化結果：把後端算好的事件/空檔排成易掃讀的卡片（文字訊息仍是事實來源） */}
              {!!m.events?.length && (
                <ul className="mt-1.5 w-[85%] space-y-1">
                  {m.events.slice(0, 8).map((ev, k) => (
                    <li
                      key={k}
                      className="flex items-center gap-2 rounded-lg border border-border bg-background/60 px-2.5 py-1.5 text-xs"
                    >
                      <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {fmt(ev.occurrence_start_utc, tz, "M/d")} {fmtTime(ev.occurrence_start_utc, tz)}–
                        {fmtTime(ev.occurrence_end_utc, tz)}
                      </span>
                      <span className="truncate">{ev.title}</span>
                      {ev.source === "agent" && (
                        <span className="ml-auto shrink-0 text-violet-500" title="由 AI 助理建立">
                          ✨
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {!!m.slots?.length && (
                <ul className="mt-1.5 w-[85%] space-y-1">
                  {m.slots.slice(0, 6).map((s, k) => (
                    <li
                      key={k}
                      className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1.5 text-xs"
                    >
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {fmt(s.start_utc, tz, "M/d")}
                      </span>
                      <span className="tabular-nums">
                        {fmtTime(s.start_utc, tz)}–{fmtTime(s.end_utc, tz)}
                      </span>
                      <span className="ml-auto text-emerald-600">空檔</span>
                    </li>
                  ))}
                </ul>
              )}

              {/* 排會預覽 → 一鍵排入 */}
              {m.optionToken && !m.resolved && (
                <Button size="sm" className="mt-1.5" disabled={busy} onClick={() => confirmSchedule(i, m.optionToken!)}>
                  確認排入行事曆
                </Button>
              )}

              {/* 破壞性動作預覽 → 第二步確認（改期/取消/回覆邀請） */}
              {m.actionToken && !m.resolved && (
                <div className="mt-1.5 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={DESTRUCTIVE.has(m.intent ?? "") ? "destructive" : "default"}
                    disabled={busy}
                    onClick={() => confirmAction(i, m.actionToken!)}
                  >
                    {confirmLabelFor(m.intent)}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => resolveAt(i)}>
                    先不要
                  </Button>
                </div>
              )}
            </div>
          ))}

          {/* 失敗後的重試：不必使用者重打整句 */}
          {failed && !busy && (
            <div className="flex justify-start">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void ask(failed)}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                重試
              </Button>
            </div>
          )}

          {busy && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground">
                <Spinner /> 思考中…
              </div>
            </div>
          )}
        </div>

        {/* 讀屏播報最新答案（視覺上隱藏） */}
        <div aria-live="polite" className="sr-only">
          {busy ? "正在處理…" : lastAgentText}
        </div>

        {/* 建議問題 */}
        <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => ask(s)}
              disabled={busy}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent"
            >
              {s}
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-border p-3">
          <div className="relative flex-1">
            <Sparkles className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              ref={inputRef}
              autoFocus
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
