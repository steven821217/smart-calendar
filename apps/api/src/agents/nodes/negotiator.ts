import type { AuthContext } from "../../auth/jwt.js";
import { computeAvailability } from "../../scheduling/availability.js";
import type { CommitteeStateType, NegotiationOption, TraceEntry } from "../state.js";
import { writeCommitteeAudit } from "./audit.js";

export interface NegotiatorDeps {
  ctx: AuthContext;
}

/**
 * Negotiator（B.3）：以 computeAvailability/findSlots 取候選 slots。
 * 首選 = 分數最高 → candidate；同時保留最多 3 個 options 供 Resource Manager 退回時使用。
 * 完全無候選 → status=error（no_availability）。
 */
export function makeNegotiator(deps: NegotiatorDeps) {
  return async function negotiator(
    state: CommitteeStateType,
  ): Promise<Partial<CommitteeStateType>> {
    if (!state.timeframe) {
      return {
        status: "error",
        code: "no_timeframe",
        message: "no timeframe resolved",
        trace: [{ node: "negotiator", note: "no timeframe" }],
      };
    }

    const { slots } = await computeAvailability(deps.ctx.workspace, {
      from_utc: state.timeframe.from_utc,
      to_utc: state.timeframe.to_utc,
      duration_minutes: state.timeframe.duration_minutes,
      member_ids: state.attendees.length > 0 ? state.attendees : undefined,
      max_results: 3,
    });

    const options: NegotiationOption[] = slots.map((s) => ({
      start_utc: s.start_utc,
      end_utc: s.end_utc,
      score: s.score,
    }));

    const trace: TraceEntry[] = [
      {
        node: "negotiator",
        note: `${options.length} candidate(s)` + (options[0] ? `, top score ${options[0].score}` : ""),
        data: { options },
      },
    ];

    if (options.length === 0) {
      await writeCommitteeAudit(deps.ctx, { node: "negotiator", timeframe: state.timeframe, options });
      return {
        status: "error",
        code: "no_availability",
        message: "指定窗口內無可用時段",
        options,
        trace,
      };
    }

    const candidate = options[0];
    await writeCommitteeAudit(deps.ctx, {
      node: "negotiator",
      timeframe: state.timeframe,
      chosen_slot: candidate,
      options,
    });

    return { status: "pending", candidate, options, trace };
  };
}
