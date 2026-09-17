import type { AuthContext } from "../../auth/jwt.js";
import { withWorkspace } from "../../db/pool.js";
import { listResources } from "../../resources/service.js";
import { handoverBufferMinutes, isHandoverResource, expandWithBuffer } from "../service.js";
import type { BookingPlan, CommitteeStateType, NegotiationOption, TraceEntry } from "../state.js";
import { writeCommitteeAudit } from "./audit.js";

export interface ResourceManagerDeps {
  ctx: AuthContext;
}

/**
 * 半開區間 [) 重疊：相接端點（間隔剛好等於 2×buffer 之和的邊界）不算重疊。
 * 與 DB EXCLUDE gist 的 tstzrange(start,end) [) 語意一致（REQ-4.5）。
 */
function overlapsHalfOpen(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** 查某資源在（含 buffer 的）擴張區間內是否已被預訂。 */
async function bufferConflicts(
  workspaceId: string,
  resourceId: string,
  expandedStartUtc: string,
  expandedEndUtc: string,
): Promise<boolean> {
  const es = new Date(expandedStartUtc).getTime();
  const ee = new Date(expandedEndUtc).getTime();
  return withWorkspace(workspaceId, async (c) => {
    const r = await c.query(
      `SELECT start_utc, end_utc FROM resource_bookings WHERE resource_id = $1`,
      [resourceId],
    );
    for (const row of r.rows) {
      const bs = new Date(row.start_utc).getTime();
      const be = new Date(row.end_utc).getTime();
      if (overlapsHalfOpen(es, ee, bs, be)) return true;
    }
    return false;
  });
}

/**
 * Resource Manager（B.4）：
 * - 解析每個 ResourceNeed → 具體 resource（named 直接；vehicle/equipment 查 workspace 內符合者）。
 * - 對需交接資源套 buffer：以 [start-B, end+B] 半開區間做重疊判定。
 * - 全可用 → 產出 booking_plan（pending，進落實分支）。
 * - 被 buffer/既有預約擋住 → 退回 negotiator 一輪（needs_decision，帶 options）。
 */
export function makeResourceManager(deps: ResourceManagerDeps) {
  return async function resourceManager(
    state: CommitteeStateType,
  ): Promise<Partial<CommitteeStateType>> {
    const trace: TraceEntry[] = [];
    if (!state.candidate) {
      return { status: "error", code: "no_candidate", message: "no candidate slot", trace: [{ node: "resourceManager", note: "no candidate" }] };
    }
    // 無資源需求 → 直接以候選時段落實（無 buffer）
    const need = state.resources[0];
    const buffer = handoverBufferMinutes();
    const all = await listResources(deps.ctx.workspace);

    const pickResource = () => {
      if (!need) return null;
      if (need.kind === "named" && need.ref) {
        return all.find((r) => String(r.name).toLowerCase().includes(need.ref!.toLowerCase())) ?? null;
      }
      // vehicle → 需交接資源；否則依 kind 對映 DB type
      if (need.kind === "vehicle") return all.find((r) => isHandoverResource(r)) ?? null;
      const dbType = need.kind === "room" ? "room" : "equipment";
      return all.find((r) => r.type === dbType) ?? null;
    };

    const resource = pickResource();
    if (need && !resource) {
      return {
        status: "needs_clarification",
        message: `找不到符合需求的資源（${need.kind}${need.ref ? `:${need.ref}` : ""}）`,
        trace: [{ node: "resourceManager", note: "no matching resource" }],
      };
    }

    // 無資源需求：以候選時段落實，不含 buffer
    if (!need || !resource) {
      const plan: BookingPlan = {
        resource_id: "",
        resource_name: "",
        needs_handover: false,
        start_utc: state.candidate.start_utc,
        end_utc: state.candidate.end_utc,
        actual_start_utc: state.candidate.start_utc,
        actual_end_utc: state.candidate.end_utc,
      };
      return { status: "pending", booking_plan: plan, trace: [{ node: "resourceManager", note: "no resource need; direct plan" }] };
    }

    const needsHandover = isHandoverResource(resource);
    // 逐一嘗試候選（首選被 buffer 擋 → 試 options）
    const tryOptions: NegotiationOption[] = [state.candidate, ...state.options.filter((o) => o.start_utc !== state.candidate!.start_utc)];
    for (const opt of tryOptions) {
      const written = needsHandover
        ? expandWithBuffer(opt.start_utc, opt.end_utc, buffer)
        : { start_utc: opt.start_utc, end_utc: opt.end_utc };
      const conflict = await bufferConflicts(deps.ctx.workspace, resource.id, written.start_utc, written.end_utc);
      if (!conflict) {
        const plan: BookingPlan = {
          resource_id: resource.id,
          resource_name: resource.name,
          needs_handover: needsHandover,
          start_utc: written.start_utc,
          end_utc: written.end_utc,
          actual_start_utc: opt.start_utc,
          actual_end_utc: opt.end_utc,
        };
        trace.push({
          node: "resourceManager",
          note: `resource ${resource.name} available at ${opt.start_utc}` + (needsHandover ? ` (±${buffer}m buffer)` : ""),
          data: { needs_handover: needsHandover, written },
        });
        await writeCommitteeAudit(deps.ctx, { node: "resourceManager", chosen_slot: opt, options: state.options });
        return { status: "pending", candidate: opt, booking_plan: plan, trace };
      }
    }

    // 全部候選都被 buffer/既有預約擋 → 談判（needs_decision）
    trace.push({
      node: "resourceManager",
      note: `resource ${resource.name} blocked by handover buffer on all candidates`,
      data: { needs_handover: needsHandover, options: state.options },
    });
    await writeCommitteeAudit(deps.ctx, { node: "resourceManager", options: state.options });
    return {
      status: "needs_decision",
      message: "首選與備案時段皆被資源交接緩衝擋住，請選擇其他時段",
      trace,
    };
  };
}
