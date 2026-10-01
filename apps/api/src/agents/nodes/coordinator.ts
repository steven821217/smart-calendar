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

/**
 * LLM structured output schema：抽 attendees/resources 實體，並明確區分
 * 「事件在做什麼」與「有哪些人參與」。
 *
 * 先前只有 attendee_ids/unresolved_names，模型就把活動名稱（打球）塞進未解析人名，
 * 使用者得到「找不到唯一對應的成員：打球」。與其猜，不如直接問模型這兩件事分別是什麼
 *（與 count_target 同一個做法：把跨欄位語意交給模型回答，對映交給後端）。
 */
const ExtractionSchema = z.object({
  event_title: z
    .string()
    .describe("這個行程在做什麼，用簡短名詞短語，不含時間與『幫我安排』等語氣詞。例：打球、見客戶、產品週會"),
  person_mentions: z
    .array(z.string())
    .describe("使用者明確指名要一起參與的人名；沒有提到任何人就給空陣列。活動名稱、地點、資源都不算人"),
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
    let attendees = extraction.attendee_ids.filter((id) => rosterIds.has(id));
    // 與會者必須有依據：使用者沒指名任何人、也沒提到團隊時，這是個人行程。
    // 實測「幫我安排今天晚上9:00打球」模型會把整個 roster 當 attendee_ids（7 人全被邀）。
    // 注意區分「明確回報沒有人」與「沒有回報這個欄位」（舊呼叫端／stub）：
    // 只有前者才可清空，後者維持原行為以免誤傷既有整合。
    const reportedMentions = extraction.person_mentions;
    const mentionsAnyPerson = reportedMentions === undefined
      ? true
      : reportedMentions.some((n) => n.trim().length > 0);
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
    if (!mentionsAnyPerson && !mentionsTeam) attendees = [];
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

    // needs_clarification 只在「使用者真的指名了某個人，但那個人解析不出來」時才成立。
    // 個人行程（打球、見客戶、保留工作時間）沒有與會者是完全正常的，不可要求補 member_id。
    // 以 person_mentions 為準：未解析名字必須同時被模型認定是「人」才算阻斷條件。
    const mentioned = new Set((extraction.person_mentions ?? []).map((n) => n.trim()).filter(Boolean));
    const unresolvedPeople = extraction.unresolved_names
      .map((n) => n.trim())
      .filter((n) => n && mentioned.has(n));
    if (unresolvedPeople.length > 0 && allAttendees.length === 0) {
      return {
        status: "needs_clarification",
        message: `找不到叫「${unresolvedPeople.join("、")}」的成員，請用完整姓名再說一次。`,
        timeframe,
        attendees: allAttendees,
        delegated_attendees: delegated,
        resources,
        trace,
      };
    }

    // 標題只保留活動本身：剝掉請求語氣、排程動詞與時間詞（封閉功能詞類，不是逐句比對）。
    const cleanTitle = (raw: string): string =>
      raw
        .replace(/^(?:幫我|幫忙|請|麻煩|我要|我想|想要|可以|能不能)+/g, "")
        .replace(/^(?:安排|排|訂|預約|建立|新增|加|開)+/g, "")
        .replace(/今天|明天|後天|今晚|明早|下週|這週|上午|下午|早上|晚上|傍晚|中午|[0-9]{1,2}\s*[:：]\s*[0-9]{2}|[0-9]{1,2}\s*[點点]\s*(?:[0-9]{1,2}\s*分?)?/g, "")
        .replace(/^[\s，、。的]+|[\s，、。的]+$/g, "")
        .trim();
    const eventTitle = cleanTitle((extraction.event_title ?? "").trim());
    return {
      status: "pending", timeframe, attendees: allAttendees, delegated_attendees: delegated, resources, trace,
      ...(eventTitle ? { event_title: eventTitle } : {}),
    };
  };
}
