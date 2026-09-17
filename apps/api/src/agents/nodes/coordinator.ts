import { z } from "zod";
import { parseEventFromText } from "@scal/shared";
import type { AuthContext } from "../../auth/jwt.js";
import type { ChatModel } from "../llm.js";
import { LlmUnavailableError } from "../llm.js";
import { listMembers } from "../service.js";
import { resolveTeamMemberships } from "../../groups/service.js";
import { coordinatorMessages } from "../prompts.js";
import type { CommitteeStateType, ResourceNeed, TraceEntry } from "../state.js";
import { writeCommitteeAudit } from "./audit.js";

/** LLM structured output schema：只抽 attendees/resources 實體。 */
const ExtractionSchema = z.object({
  attendee_ids: z.array(z.string()).describe("membership ids uniquely matched from the roster"),
  unresolved_names: z.array(z.string()).describe("names that had no unique roster match"),
  resources: z
    .array(
      z.object({
        kind: z.enum(["vehicle", "room", "equipment", "named"]),
        // OpenAI strict structured-outputs：optional 欄位須同時 nullable，否則
        // ChatOpenAI.withStructuredOutput 於轉換期即拒（僅接真實 model 才會觸發，stub 不會）。
        ref: z.string().nullish(),
      }),
    )
    .describe("resource needs extracted from the task"),
});

export interface CoordinatorDeps {
  ctx: AuthContext;
  model: ChatModel;
}

/**
 * Coordinator（B.2）：
 * - 時間重用 parseEventFromText（純函式，reference_now_utc/default_timezone）。
 * - attendees/resources 以注入 model 的 structured output 抽取；名字→member 唯一比對，
 *   否則 needs_clarification（不臆測）。
 * - 缺 timeframe / 無可解析 attendee → needs_clarification，終止圖。
 */
export function makeCoordinator(deps: CoordinatorDeps) {
  return async function coordinator(
    state: CommitteeStateType,
  ): Promise<Partial<CommitteeStateType>> {
    const trace: TraceEntry[] = [];

    // 1) 時間：既有 parser（中英相對時間、星期、DST）
    const draft = parseEventFromText({
      text: state.task_description,
      reference_now_utc: state.reference_now_utc,
      default_timezone: state.default_timezone,
    });
    const from = new Date(draft.start_utc);
    const durationMin = Math.max(
      15,
      Math.round((new Date(draft.end_utc).getTime() - from.getTime()) / 60_000),
    );
    // 搜尋窗：以解析出的當天為中心，往後開一段窗口讓 negotiator 找備案
    const windowStart = from.getTime();
    const windowEnd = windowStart + Math.max(8 * 60, durationMin) * 60_000;
    const timeframe = {
      from_utc: new Date(windowStart).toISOString(),
      to_utc: new Date(windowEnd).toISOString(),
      duration_minutes: durationMin,
    };

    // 2) attendees / resources：LLM structured output
    const roster = await listMembers(deps.ctx.workspace);
    const rosterIds = new Set(roster.map((m) => m.membership_id));
    let extraction: z.infer<typeof ExtractionSchema>;
    try {
      extraction = await deps.model.invokeStructured(
        ExtractionSchema,
        coordinatorMessages(state.task_description, roster),
      );
    } catch (e) {
      const msg = e instanceof LlmUnavailableError ? e.message : "coordinator extraction failed";
      return { status: "error", code: "llm_unavailable", message: msg, trace: [{ node: "coordinator", note: msg }] };
    }

    // 名字→member：只接受在 roster 內的 id（ZT：忽略 LLM 幻覺 id）
    const attendees = extraction.attendee_ids.filter((id) => rosterIds.has(id));
    const resources: ResourceNeed[] = extraction.resources.map((r) => ({ kind: r.kind, ref: r.ref ?? undefined }));

    // 團隊代名詞解析（feature-team-groups Req 2.1）：文字含「我的組員/我的團隊/team/組員/團隊」
    // → 呼叫 groups service 把模糊代名詞解析為真實 member membership_id。
    // 這些成員視為「委派型」（delegated）：Leader 幫 Member 排，落實時設 rsvp_status='pending'。
    const TEAM_PRONOUNS = ["我的組員", "我的團隊", "組員", "團隊", "my team", "my group", "team members", "the team"];
    const text = state.task_description.toLowerCase();
    const mentionsTeam = TEAM_PRONOUNS.some((p) => text.includes(p.toLowerCase()));
    let delegated: string[] = [];
    if (mentionsTeam) {
      try {
        const teamMembers = await resolveTeamMemberships(deps.ctx.workspace, deps.ctx.sub);
        // requester 自己（sub）不算被委派對象
        delegated = teamMembers.filter((id) => id !== deps.ctx.sub && !attendees.includes(id));
      } catch {
        delegated = [];
      }
    }
    // 合併：委員會的 free/busy 需把全體（含委派成員）納入
    const allAttendees = [...new Set([...attendees, ...delegated])];

    trace.push({
      node: "coordinator",
      note: `parsed timeframe + ${allAttendees.length} attendee(s) (${delegated.length} delegated), ${resources.length} resource need(s)`,
      data: { timeframe, attendees: allAttendees, delegated, resources, unresolved: extraction.unresolved_names },
    });

    await writeCommitteeAudit(deps.ctx, {
      node: "coordinator",
      task_description: state.task_description,
      timeframe,
    });

    // needs_clarification：有未解析名字，或完全沒有可用 attendee（且非團隊派發）
    if (extraction.unresolved_names.length > 0 && allAttendees.length === 0) {
      return {
        status: "needs_clarification",
        message: `找不到唯一對應的成員：${extraction.unresolved_names.join(", ")}，請提供 member_id 或完整姓名`,
        timeframe,
        attendees: allAttendees,
        delegated_attendees: delegated,
        resources,
        trace,
      };
    }

    return { status: "pending", timeframe, attendees: allAttendees, delegated_attendees: delegated, resources, trace };
  };
}
