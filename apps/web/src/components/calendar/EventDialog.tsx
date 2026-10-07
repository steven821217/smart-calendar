import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { X, Sparkles } from "lucide-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
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

const eventFormSchema = z.object({
  title: z.string().trim().min(1, "標題不可為空").max(300, "標題過長"),
  start_local: z.string().min(1, "必填"),
  end_local: z.string().min(1, "必填"),
  rrule: z.string().nullable(),
  visibility: z.enum(["public", "busy", "private"]),
  location: z.string().nullable(),
  attendees: z.array(z.string()),
}).refine((data) => {
  return data.start_local < data.end_local;
}, {
  message: "結束時間必須晚於開始時間",
  path: ["end_local"],
});

export type EventFormValue = z.infer<typeof eventFormSchema>;

interface Props {
  mode: "create" | "edit";
  tz: string;
  workspaceId: string;
  initial: EventFormValue;
  recurring?: boolean;
  originHint?: { start_utc: string; end_utc: string; event_tz: string };
  source?: string;
  participants?: EventParticipant[];
  participantsLoading?: boolean;
  submitting?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSubmit: (value: EventFormValue, scope: Scope) => void;
  onDelete?: (scope: Scope) => void;
}

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
  const { register, handleSubmit, control, watch, setValue, formState: { errors } } = useForm<EventFormValue>({
    resolver: zodResolver(eventFormSchema),
    defaultValues: initial,
  });

  const [scope, setScope] = useState<Scope>("this");
  const attendeesInitialised = useRef(false);

  useEffect(() => {
    if (attendeesInitialised.current || !participants || participants.length === 0) return;
    attendeesInitialised.current = true;
    const initialAttendees = initial.attendees || [];
    if (initialAttendees.length === 0) {
      const p = participants.filter((p) => !p.is_organizer && p.member_id).map((p) => p.member_id as string);
      setValue("attendees", p);
    }
  }, [participants, initial.attendees, setValue]);

  const reduce = useReducedMotion();

  const startLocal = watch("start_local");
  const endLocal = watch("end_local");

  const startDate = startLocal ? startLocal.split("T")[0] : "";
  const dayFromUtc = startDate ? localToUtc(`${startDate}T00:00`, tz) : "";
  const dayToUtc = startDate ? localToUtc(`${startDate}T23:59`, tz) : "";
  
  const durationMinutes = startLocal && endLocal ? Math.max(0, Math.round((new Date(localToUtc(endLocal, tz)).getTime() - new Date(localToUtc(startLocal, tz)).getTime()) / 60000)) : 0;

  const handleFormSubmit = handleSubmit((data) => {
    if (data.location === "") data.location = null;
    if (data.rrule === "") data.rrule = null;
    onSubmit(data, scope);
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={mode === "create" ? "建立事件" : "編輯事件"}
      onClick={onCancel}
    >
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
          <Button type="button" variant="ghost" size="icon" onClick={onCancel} aria-label="關閉">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <form onSubmit={handleFormSubmit} className="flex min-h-0 flex-1 flex-col">
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
                {...register("title")}
                autoFocus
              />
              {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="ev-start">
                  開始
                </label>
                <Input
                  id="ev-start"
                  type="datetime-local"
                  {...register("start_local")}
                />
                {errors.start_local && <p className="text-xs text-destructive">{errors.start_local.message}</p>}
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="ev-end">
                  結束
                </label>
                <Input
                  id="ev-end"
                  type="datetime-local"
                  {...register("end_local")}
                />
                {errors.end_local && <p className="text-xs text-destructive">{errors.end_local.message}</p>}
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
                {...register("location")}
              />
            </div>

            <Controller
              control={control}
              name="attendees"
              render={({ field }) => (
                <AttendeePicker
                  selected={field.value || []}
                  onChange={field.onChange}
                  existing={participants}
                  disabled={submitting}
                />
              )}
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
                  {...register("visibility")}
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
                  {...register("rrule")}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">不重複</option>
                  <option value="FREQ=DAILY">每天</option>
                  <option value="FREQ=WEEKLY">每週</option>
                  <option value="FREQ=MONTHLY">每月</option>
                </select>
              </div>
            </div>

            {mode === "create" && (
              <AvailabilityPanel
                dayUtcFrom={dayFromUtc}
                dayUtcTo={dayToUtc}
                durationMinutes={durationMinutes}
                tz={tz}
                workspaceId={workspaceId}
                onPick={(slot) => {
                  setValue("start_local", utcToLocal(slot.start_utc, tz));
                  setValue("end_local", utcToLocal(slot.end_utc, tz));
                }}
              />
            )}

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
