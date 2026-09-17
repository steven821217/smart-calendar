import type { AuthContext } from "../auth/jwt.js";
import { guardTool, McpAuthError } from "./guard.js";
import { createEvent, listOccurrences } from "../events/service.js";
import { bookResource } from "../resources/service.js";
import { findSlots, type Interval } from "../scheduling/freebusy.js";
import { parseEventFromText } from "@scal/shared";
import { runCalendarCommittee } from "../agents/calendar_graph.js";
import type { ChatModel } from "../agents/llm.js";
import { commitSchedulingPlan } from "../agents/service.js";
import { signOptionToken, verifyOptionToken } from "../agents/option_token.js";
import { publishEvent } from "../integrations/webhooks.js";

/**
 * MCP tool handlers：全部經 guardTool（同一授權鏈），再呼叫既有 Service 層
 * （ZT-3：不直接接觸 DB，無旁路）。workspace 一律來自 auth.workspace。
 */

export async function toolFindAvailability(
  auth: AuthContext | null,
  args: { from_utc: string; to_utc: string; duration_minutes: number; busy?: Interval[]; max_results?: number },
) {
  const ctx = await guardTool(auth, "find_available_time_slots", "availability.read", { type: "availability" });
  void ctx;
  const slots = findSlots(
    args.busy ?? [],
    new Date(args.from_utc).getTime(),
    new Date(args.to_utc).getTime(),
    args.duration_minutes * 60_000,
    args.max_results ?? 5,
  );
  return { slots, note: "private events shown as busy only" };
}

export async function toolCreateSmartEvent(
  auth: AuthContext | null,
  args: {
    calendar_id: string; title: string; start_utc: string; end_utc: string;
    timezone: string; rrule?: string;
  },
) {
  const ctx = await guardTool(auth, "create_smart_event", "event.create", { type: "event" });
  const ev = await createEvent(ctx.workspace, {
    calendar_id: args.calendar_id, title: args.title,
    start_utc: args.start_utc, end_utc: args.end_utc, timezone: args.timezone,
    rrule: args.rrule ?? null, created_by: ctx.sub, source: "agent", // 稽核來源 (MCP-5)
  } as never);
  return { status: "created", event: ev };
}

export async function toolBookResource(
  auth: AuthContext | null,
  args: {
    resource_id: string;
    event_id: string;
    start_utc: string;
    end_utc: string;
    confirm?: boolean;
  },
) {
  const ctx = await guardTool(auth, "book_resource", "resource.book", { type: "resource" });
  // MCP-12：破壞性/佔用型動作需二次確認；未帶 confirm=true → 回 confirmation_required，不落實
  if (!args.confirm) {
    return {
      status: "confirmation_required",
      require_confirmation: true,
      preview: {
        resource_id: args.resource_id,
        event_id: args.event_id,
        start_utc: args.start_utc,
        end_utc: args.end_utc,
      },
      note: "re-call with confirm=true to book",
    };
  }
  const booking = await bookResource(ctx.workspace, {
    resource_id: args.resource_id,
    event_id: args.event_id,
    start_utc: args.start_utc,
    end_utc: args.end_utc,
  });
  return { status: "booked", booking };
}

export async function toolListOccurrences(
  auth: AuthContext | null,
  args: { from_utc: string; to_utc: string },
) {
  const ctx = await guardTool(auth, "list_event_occurrences", "event.read", { type: "event" });
  return listOccurrences(ctx.workspace, new Date(args.from_utc), new Date(args.to_utc));
}

/** Tool 6：parse_event_from_text — NL→草稿（只讀，不落 DB，MCP-11 精神：僅產草稿）。 */
export async function toolParseEventFromText(
  auth: AuthContext | null,
  args: { text: string; reference_now_utc?: string; default_timezone: string },
) {
  const ctx = await guardTool(auth, "parse_event_from_text", "event.create", { type: "event" });
  void ctx;
  const draft = parseEventFromText({
    text: args.text,
    reference_now_utc: args.reference_now_utc,
    default_timezone: args.default_timezone,
  });
  return { status: "draft", draft };
}

/**
 * Tool 7（高階委派）：delegate_complex_scheduling（REQ-3 / mcp-api.md）。
 * - guardTool 進入（event.write），撤銷/PDP 於此重新求值。
 * - 聚合斷言 scope 同時含 availability.read + event.write + resource.book，否則 insufficient_scope。
 * - 呼叫 runCalendarCommittee；依 status 對映輸出。
 * - confirm 語意：false → 只回 needs_decision/預覽，不落實（committee 內已短路）。
 */
export async function toolDelegateComplexScheduling(
  auth: AuthContext | null,
  args: {
    task_description: string;
    reference_now_utc?: string;
    default_timezone?: string;
    confirm?: boolean;
    explain?: boolean;
    calendar_id?: string;
    title?: string;
    option_token?: string; // 延伸 C / X.1：一鍵確認
  },
  opts: { model?: ChatModel } = {},
) {
  const ctx = await guardTool(auth, "delegate_complex_scheduling", "event.create", { type: "event" });

  // 聚合斷言：高階 tool 觸發多動作，須具備全部必要 scope（design §6 (A)）
  const have = new Set(ctx.scope ?? []);
  for (const need of ["availability.read", "event.write", "resource.book"]) {
    if (!have.has(need)) {
      throw new McpAuthError("insufficient_scope", `delegate_complex_scheduling requires scope ${need}`);
    }
  }

  // X.1 一鍵確認：confirm=true 且帶 option_token → 免重跑圖，驗章後直接落實。
  if (args.confirm && args.option_token) {
    const claims = verifyOptionToken(args.option_token, ctx.workspace);
    const committed = await commitSchedulingPlan(ctx, {
      calendar_id: claims.calendar_id,
      title: claims.title,
      timezone: claims.timezone,
      actual_start_utc: claims.actual_start_utc,
      actual_end_utc: claims.actual_end_utc,
      attendees: claims.attendees,
      resource_id: claims.resource_id,
      booking_start_utc: claims.booking_start_utc,
      booking_end_utc: claims.booking_end_utc,
      needs_handover: claims.needs_handover,
    });
    return {
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
        reminders: committed.reminders.map((r) => ({ id: r.id, lead_minutes: r.lead_minutes, channel: r.channel })),
        rsvp_invitations: committed.rsvp_invitations,
      },
    };
  }

  const state = await runCalendarCommittee(
    ctx,
    {
      task_description: args.task_description,
      reference_now_utc: args.reference_now_utc,
      default_timezone: args.default_timezone ?? "UTC",
      confirm: args.confirm ?? false,
      explain: args.explain ?? false,
      calendar_id: args.calendar_id,
      title: args.title,
    },
    { model: opts.model },
  );

  // explain（功能 B）：回 trace，絕不落實
  if (state.explain) {
    return { status: state.status, explain: true, trace: state.trace, message: state.message };
  }

  switch (state.status) {
    case "booked":
      return { status: "booked", result: state.result };
    case "needs_decision": {
      const r = (state.result ?? {}) as Record<string, unknown>;
      // X.1：若有可行的 booking_plan（confirm=false 的預覽），為其簽 option_token 供一鍵確認。
      let option_token: string | undefined;
      if (state.booking_plan?.resource_id && state.candidate) {
        option_token = signOptionToken({
          workspace: ctx.workspace,
          calendar_id: args.calendar_id ?? (await firstCalendarId(ctx.workspace)) ?? "",
          attendees: state.attendees,
          resource_id: state.booking_plan.resource_id,
          needs_handover: state.booking_plan.needs_handover,
          actual_start_utc: state.booking_plan.actual_start_utc,
          actual_end_utc: state.booking_plan.actual_end_utc,
          booking_start_utc: state.booking_plan.start_utc,
          booking_end_utc: state.booking_plan.end_utc,
          title: args.title ?? state.task_description.slice(0, 60),
          timezone: args.default_timezone ?? "UTC",
        });
      }
      // X.2：needs_decision 觸發 webhook（best-effort，不阻斷回應）。
      try {
        await publishEvent(ctx.workspace, "scheduling.needs_decision", {
          id: `committee.${Date.now()}`,
          options: state.options,
          preview: r.preview,
        });
      } catch {
        // webhook 失敗不影響 tool 回應
      }
      return {
        status: "needs_decision",
        require_confirmation: true,
        options: state.options,
        preview: r.preview,
        ...(option_token ? { option_token } : {}),
        note: "re-call with confirm=true and option_token to book",
      };
    }
    case "needs_clarification":
      return { status: "needs_clarification", message: state.message };
    default:
      return { status: "error", message: state.message ?? "committee failed", code: state.code };
  }
}

async function firstCalendarId(workspaceId: string): Promise<string | null> {
  const { withWorkspace } = await import("../db/pool.js");
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(`SELECT id FROM calendars ORDER BY created_at LIMIT 1`);
    return r.rows[0]?.id ?? null;
  });
}
