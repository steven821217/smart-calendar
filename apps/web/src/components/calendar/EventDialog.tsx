import { useEffect, useRef, useState, type FormEvent } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { X, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AttendeePicker, ParticipantStatusList } from "@/components/calendar/AttendeePicker";
import type { EventParticipant } from "@/lib/api";
import { Spinner } from "@/components/ui/feedback";
import { AvailabilityPanel } from "@/components/calendar/AvailabilityPanel";
import { viewerWallToUtc, utcToViewer, dualTz } from "@/lib/time";
import { cn } from "@/lib/utils";

// datetime-local 牆上時間字串 → UTC ISO（觀看者時區）。
function localToUtc(local: string, tz: string): string {
  const [date, time] = local.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return viewerWallToUtc(new Date(y, mo - 1, d, h, mi), tz).toISOString();
}
// UTC ISO → datetime-local（觀看者牆上時間）。
function utcToLocal(utcIso: string, tz: string): string {
  const z = utcToViewer(utcIso, tz);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${z.getFullYear()}-${p(z.getMonth() + 1)}-${p(z.getDate())}T${p(z.getHours())}:${p(z.getMinutes())}`;
}

export type Scope = "this" | "this_and_future" | "all";

export interface EventFormValue {
  title: string;
  start_local: string; // datetime-local（觀看者時區牆上時間）
  end_local: string;
  rrule: string | null;
  visibility: string;
  location: string | null;
  /** 被邀請的 membership_id（不含自己；自己一律是發起人）。 */
  attendees?: string[];
}

interface Props {
  mode: "create" | "edit";
  tz: string;
  workspaceId: string;
  initial: EventFormValue;
  /** 編輯的是重複事件 → 需選 scope。 */
  recurring?: boolean;
  /** 該 occurrence 的原始時區 + UTC 起訖，用於跨時區雙時區顯示（UI-2）。 */
  originHint?: { start_utc: string; end_utc: string; event_tz: string };
  /** 事件來源（app | agent）；agent 表示由 AI 助理排程。 */
  source?: string;
  /** 編輯既有事件時的與會者名單（含回覆狀態），用於顯示誰已接受／待回覆。 */
  participants?: EventParticipant[];
  /** 是否仍在載入與會者名單。 */
  participantsLoading?: boolean;
  submitting?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSubmit: (value: EventFormValue, scope: Scope) => void;
  onDelete?: (scope: Scope) => void;
}

/** 建立/編輯事件（9.4）。重複事件提供 this/this_and_future/all（UI-5）。 */
export function EventDialog({
  mode,
  tz,
  workspaceId,
  initial,
  recurring,
  originHint,
  source,
  participants,
  participantsLoading,
  submitting,
  error,
  onCancel,
  onSubmit,
  onDelete,
}: Props) {
  const [v, setV] = useState<EventFormValue>(initial);
  const [scope, setScope] = useState<Scope>("this");
  // 與會者名單是非同步載入的。若不先把既有名單填進表單，使用者勾選任何一個人就會
  // 把其他既有與會者當成「被移除」而刪掉（PUT 是取代語意）。
  // 只在尚未初始化時填入，避免蓋掉使用者已做的勾選。
  const attendeesInitialised = useRef(false);
  useEffect(() => {
    if (attendeesInitialised.current || !participants || participants.length === 0) return;
    attendeesInitialised.current = true;
    setV((prev) =>
      prev.attendees === undefined
        ? {
            ...prev,
            attendees: participants
              .filter((p) => !p.is_organizer && p.member_id)
              .map((p) => p.member_id as string),
          }
        : prev,
    );
  }, [participants]);
  const set = (patch: Partial<EventFormValue>) => setV((s) => ({ ...s, ...patch }));
  const reduce = useReducedMotion();

  // 空檔查詢：以 start_local 當日 00:00–24:00 為窗口，時長取 end-start（分鐘）
  const startDate = v.start_local.split("T")[0];
  const dayFromUtc = startDate ? localToUtc(`${startDate}T00:00`, tz) : "";
  const dayToUtc = startDate ? localToUtc(`${startDate}T23:59`, tz) : "";
  const durationMinutes =
    v.start_local && v.end_local
      ? Math.max(
          0,
          Math.round(
            (new Date(localToUtc(v.end_local, tz)).getTime() -
              new Date(localToUtc(v.start_local, tz)).getTime()) /
              60000,
          ),
        )
      : 0;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(v, scope);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={mode === "create" ? "建立事件" : "編輯事件"}
      onClick={onCancel}
    >
      {/*
        高度受限 + 內容區可卷動：欄位變多（例如與會者清單）時，
        確定／取消按鈕必須永遠按得到，不可被推出畫面外。
        結構＝標頭固定｜內容捲動｜按鈕列釘底。
      */}
      <motion.div
        initial={reduce ? false : { opacity: 0, scale: 0.97, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold">
            {mode === "create" ? "建立事件" : "編輯事件"}
          </h2>
          <Button variant="ghost" size="icon" onClick={onCancel} aria-label="關閉">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {mode === "edit" && source === "agent" && (
          <div className="flex items-center gap-2 rounded-md bg-violet-500/10 px-3 py-2 text-xs text-foreground ring-1 ring-inset ring-violet-500/30">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-500" aria-hidden />
            此事件由 AI 助理透過排程委員會建立。你仍可在此編輯或改期。
          </div>
        )}
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="ev-title">
              標題
            </label>
            <Input
              id="ev-title"
              value={v.title}
              onChange={(e) => set({ title: e.target.value })}
              required
              maxLength={300}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="ev-start">
                開始
              </label>
              <Input
                id="ev-start"
                type="datetime-local"
                value={v.start_local}
                onChange={(e) => set({ start_local: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="ev-end">
                結束
              </label>
              <Input
                id="ev-end"
                type="datetime-local"
                value={v.end_local}
                onChange={(e) => set({ end_local: e.target.value })}
                required
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">時區：{tz}（顯示為你的當地時間）</p>
          {originHint && originHint.event_tz !== tz && (
            <div className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
              <div className="font-medium text-foreground">跨時區</div>
              <div className="text-muted-foreground">
                開始：{dualTz(originHint.start_utc, tz, originHint.event_tz)}
              </div>
              <div className="text-muted-foreground">
                結束：{dualTz(originHint.end_utc, tz, originHint.event_tz)}
              </div>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="ev-loc">
              地點
            </label>
            <Input
              id="ev-loc"
              value={v.location ?? ""}
              onChange={(e) => set({ location: e.target.value || null })}
            />
          </div>

          <AttendeePicker
            selected={v.attendees ?? []}
            onChange={(attendees) => set({ attendees })}
            existing={participants}
            disabled={submitting}
          />

          {mode === "edit" && (
            <div className="space-y-1">
              <p className="text-sm font-medium">目前與會者</p>
              {participantsLoading ? (
                <p className="text-xs text-muted-foreground">載入中…</p>
              ) : (
                <ParticipantStatusList participants={participants ?? []} />
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="ev-vis">
                可見度
              </label>
              <select
                id="ev-vis"
                value={v.visibility}
                onChange={(e) => set({ visibility: e.target.value })}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="busy">Busy（僅顯示忙碌）</option>
                <option value="public">Public（公開）</option>
                <option value="private">Private（私密）</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="ev-rrule">
                重複（RRULE）
              </label>
              <select
                id="ev-rrule"
                value={v.rrule ?? ""}
                onChange={(e) => set({ rrule: e.target.value || null })}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">不重複</option>
                <option value="FREQ=DAILY">每天</option>
                <option value="FREQ=WEEKLY">每週</option>
                <option value="FREQ=MONTHLY">每月</option>
              </select>
            </div>
          </div>

          {/* 空檔建議卡片（僅建立模式，9.5） */}
          {mode === "create" && (
            <AvailabilityPanel
              dayUtcFrom={dayFromUtc}
              dayUtcTo={dayToUtc}
              durationMinutes={durationMinutes}
              tz={tz}
              workspaceId={workspaceId}
              onPick={(slot) =>
                set({
                  start_local: utcToLocal(slot.start_utc, tz),
                  end_local: utcToLocal(slot.end_utc, tz),
                })
              }
            />
          )}

          {/* ScopeChooser：僅編輯重複事件時出現 */}
          {mode === "edit" && recurring && (
            <div className="space-y-1 rounded-md border border-border p-3">
              <span className="text-sm font-medium">套用範圍</span>
              <div className="flex flex-col gap-1.5 pt-1">
                {(
                  [
                    ["this", "僅這一次"],
                    ["this_and_future", "這次及之後"],
                    ["all", "所有場次"],
                  ] as [Scope, string][]
                ).map(([val, label]) => (
                  <label key={val} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="scope"
                      checked={scope === val}
                      onChange={() => setScope(val)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          )}

          </div>

          <div className="shrink-0 space-y-3 border-t border-border px-5 py-3">
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className={cn("flex gap-2", mode === "edit" && onDelete ? "justify-between" : "justify-end")}>
            {mode === "edit" && onDelete && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={submitting}
                onClick={() => onDelete(recurring ? scope : "all")}
              >
                刪除
              </Button>
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={submitting}>
                取消
              </Button>
              <Button type="submit" size="sm" disabled={submitting}>
                {submitting && <Spinner />}
                {mode === "create" ? "建立" : "儲存"}
              </Button>
            </div>
          </div>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
