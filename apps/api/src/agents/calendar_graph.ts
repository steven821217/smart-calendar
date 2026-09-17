import { StateGraph, START, END } from "@langchain/langgraph";
import type { AuthContext } from "../auth/jwt.js";
import { getEvent } from "../events/service.js";
import { withWorkspace } from "../db/pool.js";
import { CommitteeAnnotation, type CommitteeStateType } from "./state.js";
import { makeChatModel, type ChatModel } from "./llm.js";
import { makeCoordinator } from "./nodes/coordinator.js";
import { makeNegotiator } from "./nodes/negotiator.js";
import { makeResourceManager } from "./nodes/resourceManager.js";
import { commitSchedulingPlan, SchedulingCommitError, handoverBufferMinutes, shrinkBuffer } from "./service.js";
import { publishEvent } from "../integrations/webhooks.js";

export interface CommitteeInput {
  task_description: string;
  reference_now_utc?: string;
  default_timezone?: string;
  confirm?: boolean;
  explain?: boolean;
  calendar_id?: string; // 落實時用；省略則取 workspace 第一本日曆
  title?: string;
}

export interface RunOptions {
  model?: ChatModel;
}

/** 節點只導向下一節點或終止；非 pending 即短路到 END（終止保證，REQ-2.3 / §8）。 */
function routeAfter(state: CommitteeStateType): "next" | typeof END {
  return state.status === "pending" ? "next" : END;
}

/**
 * runCalendarCommittee（B.5）：組裝 StateGraph（coordinator → negotiator → resourceManager），
 * 每個節點只導向下一節點或 END（無無限迴圈）。resourceManager 後在此函式外做落實分支。
 */
export async function runCalendarCommittee(
  ctx: AuthContext,
  input: CommitteeInput,
  opts: RunOptions = {},
): Promise<CommitteeStateType> {
  const model = opts.model ?? makeChatModel();

  const graph = new StateGraph(CommitteeAnnotation)
    .addNode("coordinator", makeCoordinator({ ctx, model }))
    .addNode("negotiator", makeNegotiator({ ctx }))
    .addNode("resourceManager", makeResourceManager({ ctx }))
    .addEdge(START, "coordinator")
    .addConditionalEdges("coordinator", (s) => (routeAfter(s) === "next" ? "negotiator" : END), {
      negotiator: "negotiator",
      [END]: END,
    })
    .addConditionalEdges("negotiator", (s) => (routeAfter(s) === "next" ? "resourceManager" : END), {
      resourceManager: "resourceManager",
      [END]: END,
    })
    .addEdge("resourceManager", END)
    .compile();

  const initial: Partial<CommitteeStateType> = {
    task_description: input.task_description,
    reference_now_utc: input.reference_now_utc ?? new Date().toISOString(),
    default_timezone: input.default_timezone ?? "UTC",
    confirm: input.confirm ?? false,
    explain: input.explain ?? false,
  };

  let state: CommitteeStateType;
  try {
    state = (await graph.invoke(initial)) as CommitteeStateType;
  } catch (e) {
    // 任一節點/圖層例外 → 終止狀態 error（不掛死，REQ-2.3）
    return {
      ...(initial as CommitteeStateType),
      status: "error",
      code: "graph_error",
      message: e instanceof Error ? e.message : "committee failed",
      trace: [{ node: "graph", note: e instanceof Error ? e.message : "error" }],
      options: [],
      attendees: [],
      resources: [],
      timeframe: null,
    };
  }

  // 非可落實終態 → 直接回（needs_clarification / needs_decision / error）
  if (state.status !== "pending" || !state.booking_plan || !state.candidate) {
    return finalizeNonBooked(state);
  }

  // explain（功能 B）或未 confirm → 短路，絕不寫 DB（REQ-6.1 / REQ-3.6）
  if (state.explain || !state.confirm) {
    return {
      ...state,
      status: "needs_decision",
      message: state.explain ? "dry-run: trace only, no DB writes" : "re-call with confirm=true to book",
      result: {
        require_confirmation: true,
        options: state.options,
        preview: {
          resource_id: state.booking_plan.resource_id || undefined,
          attendees: state.attendees,
          slot: { start_utc: state.candidate.start_utc, end_utc: state.candidate.end_utc },
        },
      },
    };
  }

  // confirm=true → 原子落實（C.4 + 功能 A）
  const calendarId = input.calendar_id ?? (await firstCalendar(ctx.workspace));
  if (!calendarId) {
    return { ...state, status: "error", code: "no_calendar", message: "no calendar in workspace" };
  }
  // 無資源需求時 booking_plan.resource_id 為空 → 無法建立 resource_bookings，
  // 本委員會聚焦「借資源」情境：無資源時回 needs_decision 讓呼叫者用低階 tool 建純事件。
  if (!state.booking_plan.resource_id) {
    return {
      ...state,
      status: "needs_decision",
      message: "no resource requested; use create_smart_event for a plain event",
      result: { options: state.options },
    };
  }

  try {
    const committed = await commitSchedulingPlan(ctx, {
      calendar_id: calendarId,
      title: input.title ?? deriveTitle(input.task_description),
      timezone: input.default_timezone ?? "UTC",
      actual_start_utc: state.booking_plan.actual_start_utc,
      actual_end_utc: state.booking_plan.actual_end_utc,
      attendees: state.attendees,
      delegated_attendees: state.delegated_attendees,
      resource_id: state.booking_plan.resource_id,
      booking_start_utc: state.booking_plan.start_utc,
      booking_end_utc: state.booking_plan.end_utc,
      needs_handover: state.booking_plan.needs_handover,
    });

    // 委派型成員：觸發 pending 通知（feature-team-groups Req 3.1）。best-effort，不阻斷回應。
    for (const inv of committed.rsvp_invitations) {
      try {
        await publishEvent(ctx.workspace, "scheduling.rsvp_pending", {
          id: `rsvp.${inv.event_id}.${inv.member_id}`,
          event_id: inv.event_id,
          member_id: inv.member_id,
          rsvp_token: inv.rsvp_token,
        });
      } catch {
        // 通知失敗不影響落實結果
      }
    }

    void getEvent; // event 已在交易內回傳，無需再查
    return {
      ...state,
      status: "booked",
      result: {
        event: {
          id: committed.event.id,
          start_utc: committed.event.start_utc,
          end_utc: committed.event.end_utc,
          source: committed.event.source,
        },
        booking: {
          id: committed.booking.id,
          resource_id: committed.booking.resource_id,
          start_utc: committed.booking.start_utc,
          end_utc: committed.booking.end_utc,
        },
        actual_usage: committed.actual_usage,
        reminders: committed.reminders.map((r) => ({
          id: r.id,
          lead_minutes: r.lead_minutes,
          channel: r.channel,
        })),
        rsvp_invitations: committed.rsvp_invitations,
      },
    };
  } catch (e) {
    if (e instanceof SchedulingCommitError) {
      return { ...state, status: "error", code: e.code, message: e.message };
    }
    return { ...state, status: "error", code: "commit_failed", message: e instanceof Error ? e.message : "commit failed" };
  }
}

/** 非 booked 終態的統一輸出（補上 shrink 後的 actual_usage 供顯示）。 */
function finalizeNonBooked(state: CommitteeStateType): CommitteeStateType {
  if (state.booking_plan?.needs_handover) {
    const b = handoverBufferMinutes();
    const shrunk = shrinkBuffer(state.booking_plan.start_utc, state.booking_plan.end_utc, b);
    void shrunk;
  }
  return state;
}

async function firstCalendar(workspaceId: string): Promise<string | null> {
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(`SELECT id FROM calendars ORDER BY created_at LIMIT 1`);
    return r.rows[0]?.id ?? null;
  });
}

function deriveTitle(task: string): string {
  const t = task.trim().slice(0, 60);
  return t || "Committee scheduled event";
}
