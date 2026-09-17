import type { AuthContext } from "../../auth/jwt.js";
import { writeAudit } from "../../audit/service.js";
import type { NegotiationOption, Timeframe } from "../state.js";

/**
 * 委員會決策稽核（功能 D）：關鍵決策寫 audit_log
 * action='committee.decision'。task_description 截斷至 200 字；
 * 只含 free/busy 等級資訊，不含跨 workspace/private 明細（REQ-7.3）。
 * 寫入失敗吞掉，不阻斷主流程（對齊既有 auditAgent）。
 */
export async function writeCommitteeAudit(
  ctx: AuthContext,
  meta: {
    node: string;
    task_description?: string;
    timeframe?: Timeframe | null;
    chosen_slot?: NegotiationOption;
    options?: NegotiationOption[];
  },
): Promise<void> {
  try {
    await writeAudit(ctx.workspace, {
      actor_type: "agent",
      agent_id: ctx.sub,
      on_behalf_of: ctx.sub,
      action: "committee.decision",
      target_type: "event",
      decision: "allow",
      metadata: {
        node: meta.node,
        task_description: meta.task_description ? meta.task_description.slice(0, 200) : undefined,
        timeframe: meta.timeframe ?? undefined,
        chosen_slot: meta.chosen_slot,
        options: meta.options,
      },
    });
  } catch {
    // 稽核不阻斷主流程
  }
}
