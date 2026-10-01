import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useMutationWithFeedback } from "@/lib/useMutationWithFeedback";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Plus } from "lucide-react";
import { startOfMonth, endOfMonth, addMonths, addWeeks, addYears, format } from "date-fns";
import { startOfWeek, endOfWeek, isSameMonth, isSameWeek } from "date-fns";
import { AppShell } from "@/components/AppShell";
import { MonthGrid } from "@/components/calendar/MonthGrid";
import { WeekGrid } from "@/components/calendar/WeekGrid";
import { EventDialog, type EventFormValue, type Scope } from "@/components/calendar/EventDialog";
import { DayAgendaDialog } from "@/components/calendar/DayAgendaDialog";
import { DragScopePrompt } from "@/components/calendar/DragScopePrompt";
import { NLQuickAdd } from "@/components/calendar/NLQuickAdd";
import { JumpPicker } from "@/components/calendar/JumpPicker";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { useAuth } from "@/store/auth";
import { api, ApiError, type Occurrence, type EventDraft } from "@/lib/api";
import { viewerWallToUtc, utcToViewer, fmtTime } from "@/lib/time";
import { nowInViewer, isSameDay } from "@/lib/calendar";
import { parseDropId, computeNewTimes, snap15 } from "@/lib/drag";
import { cn } from "@/lib/utils";

type View = "month" | "week";

interface RescheduleArgs {
  occ: Occurrence;
  scope: Scope;
  start_utc: string;
  end_utc: string;
}

// datetime-local 值（觀看者牆上時間）；用於編輯回填。
function toLocalInput(d: Date): string {
  return format(d, "yyyy-MM-dd'T'HH:mm");
}
// 觀看者牆上時間字串 → UTC ISO（送後端）。
function localToUtcIso(local: string, tz: string): string {
  // datetime-local 無時區，視為觀看者牆上時間
  const [date, time] = local.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = new Date(y, mo - 1, d, h, mi);
  return viewerWallToUtc(wall, tz).toISOString();
}

export function CalendarPage() {
  const me = useAuth((s) => s.me)!;
  const tz = me.timezone;
  const qc = useQueryClient();

  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState<Date>(() => nowInViewer(tz));
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  /** 開啟中的「當日完整行程」（月視圖每格只放得下少數事件，其餘在此檢視）。 */
  const [agendaDay, setAgendaDay] = useState<Date | null>(null);
  const [dialog, setDialog] = useState<
    | { mode: "create"; initial: EventFormValue }
    | { mode: "edit"; occ: Occurrence; initial: EventFormValue; recurring: boolean }
    | null
  >(null);
  const [mutErr, setMutErr] = useState<string | null>(null);

  // 查詢窗口：月視圖含補滿週、週視圖含整週
  const [fromUtc, toUtc] = useMemo(() => {
    if (view === "month") {
      const s = startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 });
      const e = endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 });
      return [s.toISOString(), e.toISOString()];
    }
    const s = startOfWeek(anchor, { weekStartsOn: 1 });
    const e = endOfWeek(anchor, { weekStartsOn: 1 });
    return [s.toISOString(), e.toISOString()];
  }, [view, anchor]);

  const { data, isLoading, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["occurrences", me.workspace.id, fromUtc, toUtc],
    queryFn: () => api.listOccurrences(fromUtc, toUtc),
    // Agent 透過 MCP 改日曆時，讓變更幾秒內自動浮現（無需手動重整）。
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  // 預設行事曆（建立事件用）
  const { data: calData } = useQuery({
    queryKey: ["calendars", me.workspace.id],
    queryFn: () => api.listCalendars(),
  });
  const defaultCalendarId = calData?.calendars[0]?.id ?? "";

  const invalidate = () => qc.invalidateQueries({ queryKey: ["occurrences"] });

  // 編輯既有事件時載入其與會者名單（顯示誰已接受／待回覆，並預先勾選）
  const editingEventId = dialog?.mode === "edit" ? dialog.occ.event_id : null;
  const participantsQ = useQuery({
    queryKey: ["event-participants", editingEventId],
    queryFn: () => api.getEvent(editingEventId!),
    enabled: !!editingEventId,
    staleTime: 0,
  });
  const editingParticipants = participantsQ.data?.participants ?? [];

  const createMut = useMutationWithFeedback({
    successMessage: "事件已建立",
    mutation: {
      mutationFn: (v: EventFormValue) =>
        api.createEvent(
          {
            calendar_id: defaultCalendarId,
            title: v.title,
            start_utc: localToUtcIso(v.start_local, tz),
            end_utc: localToUtcIso(v.end_local, tz),
            timezone: tz,
            rrule: v.rrule,
            visibility: v.visibility,
            location: v.location,
            participants: (v.attendees ?? []).map((id) => ({ member_id: id })),
          },
          crypto.randomUUID(),
        ),
      onSuccess: () => {
        setDialog(null);
        invalidate();
      },
      onError: (e) => setMutErr(e instanceof ApiError ? (e.detail ?? e.title) : "建立失敗"),
    },
  });

  const updateMut = useMutationWithFeedback({
    successMessage: "事件已更新",
    mutation: {
      mutationFn: async ({ occ, v, scope }: { occ: Occurrence; v: EventFormValue; scope: Scope }) => {
        // 與會者是獨立資源（不隨 recurrence scope 分岔），事件更新成功後再同步一次
        const r = await api.updateEvent(occ.event_id, scope, {
          title: v.title,
          start_utc: localToUtcIso(v.start_local, tz),
          end_utc: localToUtcIso(v.end_local, tz),
          timezone: tz,
          visibility: v.visibility,
          occurrence_start_utc: occ.occurrence_start_utc,
        });
        if (v.attendees) await api.setEventParticipants(occ.event_id, v.attendees);
        return r;
      },
      onSuccess: () => {
        setDialog(null);
        invalidate();
      },
      onError: (e) => setMutErr(e instanceof ApiError ? (e.detail ?? e.title) : "更新失敗"),
    },
  });

  const deleteMut = useMutationWithFeedback({
    successMessage: "事件已刪除",
    mutation: {
      mutationFn: ({ occ, scope }: { occ: Occurrence; scope: Scope }) =>
        api.deleteEvent(occ.event_id, scope, occ.occurrence_start_utc),
      onSuccess: () => {
        setDialog(null);
        invalidate();
      },
      onError: (e) => setMutErr(e instanceof ApiError ? (e.detail ?? e.title) : "刪除失敗"),
    },
  });

  // 拖曳改期（9.3）：樂觀更新 → PATCH → 409 回滾 + suggested_slots
  const occKey = ["occurrences", me.workspace.id, fromUtc, toUtc];
  const rescheduleMut = useMutationWithFeedback({
    successMessage: "已改期",
    onErrorToast: (e) => {
      // 409 客製 toast（附建議時段 action）；回傳 false 抑制預設 error toast
      if (e instanceof ApiError && e.status === 409) {
        const slots = (e.body?.suggested_slots as { start_utc: string }[] | undefined) ?? [];
        const first = slots[0];
        toast.error("時間衝突，已還原", {
          description: slots.length
            ? `建議時段：${slots.map((s) => fmtTime(s.start_utc, tz)).join("、")}`
            : undefined,
          action: first
            ? {
                label: "查看建議時段",
                onClick: () => setAnchor(utcToViewer(first.start_utc, tz)),
              }
            : undefined,
        });
        return false;
      }
    },
    mutation: {
      mutationFn: ({ occ, scope, start_utc, end_utc }: RescheduleArgs) =>
        api.updateEvent(occ.event_id, scope, {
          start_utc,
          end_utc,
          timezone: tz,
          occurrence_start_utc: occ.occurrence_start_utc,
        }),
      // 樂觀更新：立刻把該 occurrence 移到新時間
      onMutate: async ({ occ, start_utc, end_utc }: RescheduleArgs) => {
        await qc.cancelQueries({ queryKey: occKey });
        const prev = qc.getQueryData<{ occurrences: Occurrence[]; next_cursor: string | null }>(occKey);
        qc.setQueryData<{ occurrences: Occurrence[]; next_cursor: string | null }>(occKey, (old) =>
          old
            ? {
                ...old,
                occurrences: old.occurrences.map((o) =>
                  o.event_id === occ.event_id && o.occurrence_start_utc === occ.occurrence_start_utc
                    ? { ...o, occurrence_start_utc: start_utc, occurrence_end_utc: end_utc }
                    : o,
                ),
              }
            : old,
        );
        return { prev };
      },
      onError: (_e, _vars, ctx) => {
        // 回滾（toast 由 onErrorToast 處理）
        if (ctx?.prev) qc.setQueryData(occKey, ctx.prev);
      },
      onSettled: () => invalidate(),
    },
  });

  // 拖曳互動狀態
  const [dragging, setDragging] = useState<Occurrence | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{
    occ: Occurrence;
    start_utc: string;
    end_utc: string;
  } | null>(null);

  const sensors = useSensors(
    // PointerSensor activation constraint：需移動 5px 才啟動，避免與點擊衝突（UI-22 觸控）
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const onDragStart = (e: DragStartEvent) => {
    const occ = e.active.data.current?.occ as Occurrence | undefined;
    if (occ) setDragging(occ);
  };

  const onDragEnd = async (e: DragEndEvent) => {
    setDragging(null);
    const occ = e.active.data.current?.occ as Occurrence | undefined;
    const overId = e.over?.id;
    if (!occ || typeof overId !== "string") return;
    const target = parseDropId(overId);
    if (!target) return;
    if (target.kind === "week" && target.minutes != null) target.minutes = snap15(target.minutes);

    const { start_utc, end_utc } = computeNewTimes(occ, target, tz);
    if (start_utc === occ.occurrence_start_utc) return; // 沒動

    setMutErr(null);
    // 判斷是否重複事件：查該 event 的 rrule；有 → 先選 scope（UI-21）
    try {
      const ev = await api.getEvent(occ.event_id);
      if (ev.rrule) {
        setPendingDrop({ occ, start_utc, end_utc });
        return;
      }
    } catch {
      // 查不到就當單次處理
    }
    rescheduleMut.mutate({ occ, scope: "all", start_utc, end_utc });
  };

  const occurrences = data?.occurrences ?? [];

  // 當日行程彈窗的資料：沿用既有查詢結果，依觀看者時區比對是否同一天
  const agendaOccurrences = useMemo(() => {
    if (!agendaDay) return [];
    return occurrences.filter((occ) => isSameDay(utcToViewer(occ.occurrence_start_utc, tz), agendaDay));
  }, [agendaDay, occurrences, tz]);

  const openCreate = (day?: Date) => {
    // 複製一份再改時間：day 可能來自月曆格／彈窗 state，不可就地修改
    const base = new Date((day ?? nowInViewer(tz)).getTime());
    base.setHours(9, 0, 0, 0);
    const end = new Date(base.getTime() + 60 * 60000);
    setMutErr(null);
    setDialog({
      mode: "create",
      initial: {
        title: "",
        start_local: toLocalInput(base),
        end_local: toLocalInput(end),
        rrule: null,
        visibility: "busy",
        location: null,
      },
    });
  };

  // NL 草稿 → 開啟建立表單（觀看者時區牆上時間回填）
  const openCreateFromDraft = (draft: EventDraft) => {
    setMutErr(null);
    setDialog({
      mode: "create",
      initial: {
        title: draft.title,
        start_local: toLocalInput(utcToViewer(draft.start_utc, tz)),
        end_local: toLocalInput(utcToViewer(draft.end_utc, tz)),
        rrule: draft.rrule,
        visibility: "busy",
        location: null,
      },
    });
  };

  const openEdit = (occ: Occurrence) => {
    setMutErr(null);
    setDialog({
      mode: "edit",
      occ,
      recurring: true, // trunk：保守假設可能重複，一律顯示 scope 選項
      initial: {
        title: occ.title,
        start_local: toLocalInput(utcToViewer(occ.occurrence_start_utc, tz)),
        end_local: toLocalInput(utcToViewer(occ.occurrence_end_utc, tz)),
        rrule: null,
        visibility: "busy",
        location: null,
      },
    });
  };

  const label =
    view === "month"
      ? format(anchor, "yyyy 年 M 月")
      : `${format(startOfWeek(anchor, { weekStartsOn: 1 }), "M/d")} – ${format(
          endOfWeek(anchor, { weekStartsOn: 1 }),
          "M/d",
        )}`;

  const navigateMonth = useCallback((dir: 1 | -1) => {
    setSelectedDay(null);
    setAnchor((current) => addMonths(current, dir));
  }, []);
  const step = (dir: 1 | -1) => {
    setSelectedDay(null);
    setAnchor((current) => (view === "month" ? addMonths(current, dir) : addWeeks(current, dir)));
  };
  const stepYear = (dir: 1 | -1) => {
    setSelectedDay(null);
    setAnchor((current) => addYears(current, dir));
  };

  // 「今天」是否已在當前檢視範圍內（給按鈕 disabled 回饋）
  const todayDate = nowInViewer(tz);
  const viewingToday =
    view === "month"
      ? isSameMonth(anchor, todayDate)
      : isSameWeek(anchor, todayDate, { weekStartsOn: 1 });

  const topbar = (
    <>
      <div className="flex h-9 items-center rounded-lg border border-border bg-muted/30 p-0.5 shadow-sm">
        <Button className="h-8 w-8" variant="ghost" size="icon" onClick={() => stepYear(-1)} aria-label="上一年" title="上一年">
          <ChevronsLeft className="h-4 w-4" aria-hidden />
        </Button>
        <Button className="h-8 w-8" variant="ghost" size="icon" onClick={() => step(-1)} aria-label={view === "month" ? "上一個月" : "上一週"}>
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <Button className="h-8 w-8" variant="ghost" size="icon" onClick={() => step(1)} aria-label={view === "month" ? "下一個月" : "下一週"}>
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
        <Button className="h-8 w-8" variant="ghost" size="icon" onClick={() => stepYear(1)} aria-label="下一年" title="下一年">
          <ChevronsRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setSelectedDay(null);
          setAnchor(nowInViewer(tz));
        }}
        disabled={viewingToday}
        title={viewingToday ? `已在本${view === "month" ? "月" : "週"}` : "回到今天"}
      >
        今天
      </Button>
      <div className="flex min-w-0 items-center gap-2">
        <JumpPicker
          anchor={anchor}
          onPick={(date) => {
            setSelectedDay(null);
            setAnchor(date);
          }}
        />
        {view === "week" && <span className="hidden text-xs text-muted-foreground tabular-nums lg:inline">{label}</span>}
      </div>
      <span className="hidden rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground 2xl:inline" title="時間依你的時區顯示">
        {tz}
      </span>
      <span
        className="hidden items-center gap-1.5 text-xs text-muted-foreground xl:flex"
        title={isFetching ? "同步中…" : `最後更新 ${new Intl.DateTimeFormat("zh-TW", { timeStyle: "medium", timeZone: tz }).format(new Date(dataUpdatedAt))}`}
        aria-live="polite"
      >
        <span className={cn("inline-block h-2 w-2 rounded-full", isFetching ? "animate-pulse bg-amber-400" : "bg-emerald-500")} aria-hidden />
        {isFetching ? "同步中" : "已同步"}
      </span>
      <div className="flex h-9 items-center rounded-lg border border-border bg-muted/30 p-0.5 shadow-sm" aria-label="日曆檢視">
        {(["month", "week"] as View[]).map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => {
              setSelectedDay(null);
              setView(candidate);
            }}
            aria-pressed={view === candidate}
            className={cn(
              "h-8 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              view === candidate ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {candidate === "month" ? "月" : "週"}
          </button>
        ))}
      </div>
      <NLQuickAdd tz={tz} onDraft={openCreateFromDraft} />
      <Button size="sm" onClick={() => openCreate()} className="shadow-sm">
        <Plus className="h-4 w-4" aria-hidden />
        建立
      </Button>
    </>
  );

  return (
    <AppShell topbar={topbar}>
      <span className="sr-only" role="status" aria-live="polite">
        目前顯示 {label}
      </span>
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        {isLoading ? (
          <div className="grid grid-cols-7 gap-px p-4">
            {Array.from({ length: 35 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : view === "month" ? (
          <div className="h-full overflow-auto">
            <MonthGrid
              anchor={anchor}
              tz={tz}
              occurrences={occurrences}
              selectedDay={selectedDay}
              onNavigateMonth={navigateMonth}
              onDayOpen={(d) => {
                // 點日期 → 開啟當日完整行程（避免每格只看得到前 3 筆）；建立動作在彈窗內明確觸發
                setSelectedDay(d);
                setAgendaDay(d);
              }}
              onEventClick={openEdit}
            />
          </div>
        ) : (
          <WeekGrid anchor={anchor} tz={tz} occurrences={occurrences} onEventClick={openEdit} />
        )}
        <DragOverlay>
          {dragging && (
            <div className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground shadow-lg">
              {fmtTime(dragging.occurrence_start_utc, tz)} {dragging.title}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* 當日完整行程：解決月視圖單日事件過多時看不到後續事件 */}
      {agendaDay && (
        <DayAgendaDialog
          day={agendaDay}
          tz={tz}
          occurrences={agendaOccurrences}
          onClose={() => setAgendaDay(null)}
          onCreate={(d) => {
            setAgendaDay(null);
            openCreate(d);
          }}
          onEventClick={(occ) => {
            setAgendaDay(null);
            openEdit(occ);
          }}
        />
      )}

      {/* 拖曳重複事件 → 選 scope 後套用 */}
      {pendingDrop && (
        <DragScopePrompt
          onCancel={() => {
            setPendingDrop(null);
            invalidate(); // 還原視覺
          }}
          onPick={(scope) => {
            rescheduleMut.mutate({
              occ: pendingDrop.occ,
              scope,
              start_utc: pendingDrop.start_utc,
              end_utc: pendingDrop.end_utc,
            });
            setPendingDrop(null);
          }}
        />
      )}

      {dialog && (
        <EventDialog
          mode={dialog.mode}
          tz={tz}
          workspaceId={me.workspace.id}
          initial={dialog.initial}
          recurring={dialog.mode === "edit" ? dialog.recurring : undefined}
          source={dialog.mode === "edit" ? dialog.occ.source : undefined}
          participants={dialog.mode === "edit" ? editingParticipants : undefined}
          participantsLoading={dialog.mode === "edit" && participantsQ.isLoading}
          originHint={
            dialog.mode === "edit"
              ? {
                  start_utc: dialog.occ.occurrence_start_utc,
                  end_utc: dialog.occ.occurrence_end_utc,
                  event_tz: dialog.occ.timezone,
                }
              : undefined
          }
          submitting={createMut.isPending || updateMut.isPending || deleteMut.isPending}
          error={mutErr}
          onCancel={() => setDialog(null)}
          onSubmit={(v, scope) => {
            if (dialog.mode === "create") createMut.mutate(v);
            else updateMut.mutate({ occ: dialog.occ, v, scope });
          }}
          onDelete={
            dialog.mode === "edit"
              ? (scope) => deleteMut.mutate({ occ: dialog.occ, scope })
              : undefined
          }
        />
      )}
    </AppShell>
  );
}
