import type { AuthContext } from "../../auth/jwt.js";
import type { ChatModel } from "../llm.js";
import { listOccurrences, listOccurrencesForMember } from "../../events/service.js";
import { computeAvailability } from "../../scheduling/availability.js";
import { listPendingForMember } from "../../events/rsvp_service.js";
import { listGroups } from "../../groups/service.js";
import { runCalendarCommittee } from "../calendar_graph.js";
import { classifyIntent, type Intent } from "./intent.js";
import {
  resolveTimeWindow, defaultWindow, windowFromSpec, daypartHours, localHour, type TimeWindow,
} from "./time-window.js";
import { extractQuerySpec, reconcileSpec, type QuerySpec } from "./query-spec.js";

/**
 * 站內對話 agent（B 方案）——能查詢也能排會，且對複雜查詢用 14B。
 *
 * 漸進增強：
 *  - 簡單問句（今天/明天有什麼、幾個會、有空嗎）→ 規則快路徑，不打 model（快、穩）。
 *  - 複雜問句（週三到週五、跟客戶的、產品團隊的、下午、第一個…）→ 呼叫 14B 抽 QuerySpec，
 *    但經 harness 清洗（normalizeSpec 清髒 null、reconcileGroup 用真實 group 覆核誤拆），
 *    時間一律後端算（windowFromSpec），過濾/排序/聚合後端做，答案模板化。
 * 授權：以登入 user 真實 role 經 PDP（查詢走 RLS，只見本 workspace）。
 */

export type AgentReplyKind = "answer" | "scheduled" | "needs_decision" | "error";
export interface AgentReply {
  kind: AgentReplyKind;
  message: string;
  intent?: string;
  via?: string;
  data?: unknown;
}
interface AgentDeps {
  model: ChatModel;
  nowUtc?: Date;
}

type Occurrence = Awaited<ReturnType<typeof listOccurrences>>[number];

const fmtTime = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", timeZone: tz, hour12: false }).format(new Date(iso));
const fmtDay = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", timeZone: tz }).format(new Date(iso));

/** 複雜訊號：出現這些就值得叫 14B 抽 QuerySpec（規則覆蓋不到）。 */
function looksComplex(text: string): boolean {
  return /週[一二三四五六日到至]|禮拜[一二三四五六]|星期[一二三四五六]|到週|至週|跟.*的|和.*的|團隊|小隊|下午|上午|早上|晚上|第一個|最早|下一個|這個月|本月/.test(
    text,
  );
}

export async function runInAppAgent(auth: AuthContext, text: string, tz: string, deps: AgentDeps): Promise<AgentReply> {
  const now = deps.nowUtc ?? new Date();
  const trimmed = text.trim();
  if (!trimmed) return { kind: "error", message: "請輸入你的問題或需求。" };

  const { intent, via } = await classifyIntent(trimmed, deps.model);

  try {
    if (intent === "schedule") return await doSchedule(auth, trimmed, tz, now, deps.model, via);
    if (intent === "list_pending") return await answerListPending(auth, via, tz);

    // 查詢類：複雜問句走 14B QuerySpec 進階路徑，否則規則快路徑。
    if (looksComplex(trimmed)) {
      const adv = await advancedQuery(auth, trimmed, tz, now, deps.model, intent);
      if (adv) return adv;
      // 進階失敗 → 降級規則路徑（絕不卡死）
    }
    if (intent === "count_events") return await answerCount(auth, trimmed, tz, now, "rules");
    if (intent === "find_free") return await answerFree(auth, trimmed, tz, now, "rules");
    return await answerList(auth, trimmed, tz, now, "rules");
  } catch {
    return { kind: "error", message: "處理時發生錯誤，請換個說法再試一次。", intent, via };
  }
}

// ---- 14B 進階路徑：抽 spec → harness 清洗/覆核 → 後端算日期 + 過濾 → 模板答案 ----

async function advancedQuery(
  auth: AuthContext, text: string, tz: string, now: Date, model: ChatModel, hintedIntent?: Intent,
): Promise<AgentReply | null> {
  const rawSpec = await extractQuerySpec(text, model);
  if (!rawSpec) return null; // model 不可用 → 讓上層降級規則

  // group 覆核 + 原文覆核（時間/daypart）
  let spec: QuerySpec = rawSpec;
  try {
    const groups = (await listGroups(auth.workspace)).map((g) => g.name);
    spec = reconcileSpec(rawSpec, text, groups);
  } catch {
    spec = reconcileSpec(rawSpec, text, []);
  }

  // 意圖覆核：規則分類（hintedIntent）比 14B 抽的 spec.intent 準 → 覆蓋。
  const mapIntent: Record<string, QuerySpec["intent"]> = {
    list_events: "list", count_events: "count", find_free: "find_free", list_pending: "pending",
  };
  if (hintedIntent && mapIntent[hintedIntent]) spec = { ...spec, intent: mapIntent[hintedIntent] };

  const win = windowFromSpec(spec.anchor, spec.weekday_from, spec.weekday_to, tz, now);
  // 若 anchor=none 且無 weekday → 用預設 7 天窗，避免掃全表
  const useWin = spec.anchor === "none" && spec.weekday_from === null ? defaultWindow(tz, now) : win;

  let occ = await listOccurrencesForMember(auth.workspace, auth.sub, new Date(useWin.from_utc), new Date(useWin.to_utc));

  // daypart 過濾（後端算，不信 model 算時間）
  const dh = daypartHours(spec.daypart);
  if (dh) occ = occ.filter((o) => { const h = localHour(o.occurrence_start_utc, tz); return h >= dh[0] && h < dh[1]; });

  // 關鍵字過濾（標題 contains）
  if (spec.filter_keyword) occ = occ.filter((o) => o.title.includes(spec.filter_keyword!));

  // group 過濾：把 group 成員的 event 篩出（用 participants）
  if (spec.group_name) occ = await filterByGroup(auth, occ, spec.group_name);

  // 排序 + order
  occ = occ.slice().sort((a, b) => +new Date(a.occurrence_start_utc) - +new Date(b.occurrence_start_utc));
  const scopeLabel = describeScope(useWin, spec);

  if (spec.intent === "count") {
    return { kind: "answer", intent: "count_events", via: "model", message: `${scopeLabel}共有 ${occ.length} 個會議/行程。`, data: { spec, window: useWin, count: occ.length } };
  }
  if (spec.intent === "find_free") {
    const { slots } = await computeAvailability(auth.workspace, { from_utc: useWin.from_utc, to_utc: useWin.to_utc, duration_minutes: 60, max_results: 5, member_ids: [auth.sub] });
    const slotsInPart = dh ? slots.filter((s) => { const h = localHour(s.start_utc, tz); return h >= dh[0] && h < dh[1]; }) : slots;
    if (slotsInPart.length === 0) return { kind: "answer", intent: "find_free", via: "model", message: `${scopeLabel}找不到 1 小時的空檔。`, data: { spec, slots: [] } };
    const lines = slotsInPart.map((s) => `• ${fmtDay(s.start_utc, tz)} ${fmtTime(s.start_utc, tz)}–${fmtTime(s.end_utc, tz)}`);
    return { kind: "answer", intent: "find_free", via: "model", message: `${scopeLabel}可用的空檔（1 小時）：\n${lines.join("\n")}`, data: { spec, slots: slotsInPart } };
  }
  // list（含 order=first → 只回最早一筆）
  if (occ.length === 0) return { kind: "answer", intent: "list_events", via: "model", message: `${scopeLabel}沒有排定的會議或行程。`, data: { spec, events: [] } };
  if (spec.order === "first") {
    const f = occ[0];
    return { kind: "answer", intent: "list_events", via: "model", message: `${scopeLabel}第一個是 ${fmtDay(f.occurrence_start_utc, tz)} ${fmtTime(f.occurrence_start_utc, tz)} ${f.title}。`, data: { spec, events: [f] } };
  }
  const lines = occ.slice(0, 10).map((o) => `• ${fmtDay(o.occurrence_start_utc, tz)} ${fmtTime(o.occurrence_start_utc, tz)} ${o.title}${o.source === "agent" ? " ✨" : ""}`);
  const more = occ.length > 10 ? `\n…還有 ${occ.length - 10} 筆` : "";
  return { kind: "answer", intent: "list_events", via: "model", message: `${scopeLabel}有 ${occ.length} 個會議/行程：\n${lines.join("\n")}${more}`, data: { spec, window: useWin, events: occ } };
}

function describeScope(win: TimeWindow, spec: QuerySpec): string {
  const parts = [win.label];
  const dp = spec.daypart === "morning" ? "上午" : spec.daypart === "afternoon" ? "下午" : spec.daypart === "evening" ? "晚上" : "";
  if (dp) parts.push(dp);
  if (spec.group_name) parts.push(`${spec.group_name}`);
  if (spec.filter_keyword) parts.push(`「${spec.filter_keyword}」`);
  return parts.join("");
}

/** 用 group 成員把 occurrences 篩成「該群組相關」的 event。 */
async function filterByGroup(auth: AuthContext, occ: Occurrence[], groupName: string): Promise<Occurrence[]> {
  const groups = await listGroups(auth.workspace);
  const g = groups.find((x) => x.name === groupName);
  if (!g) return occ;
  const { listGroupMembers } = await import("../../groups/service.js");
  const members = await listGroupMembers(auth.workspace, g.id);
  const memberIds = new Set(members.map((m) => m.membership_id).filter(Boolean));
  if (memberIds.size === 0) return occ;
  // 用 availability 的同款 participant 對映：留有該群成員參與的 event
  const { withWorkspace } = await import("../../db/pool.js");
  const eventIds = await withWorkspace(auth.workspace, async (c) => {
    const r = await c.query(
      `SELECT DISTINCT event_id FROM event_participants WHERE member_id = ANY($1::uuid[])`,
      [Array.from(memberIds)],
    );
    return new Set<string>(r.rows.map((x) => x.event_id));
  });
  return occ.filter((o) => eventIds.has(o.event_id));
}

// ---- 規則快路徑（簡單問句，不打 model）----

async function answerList(auth: AuthContext, text: string, tz: string, now: Date, via: string): Promise<AgentReply> {
  const win = resolveTimeWindow(text, tz, now) ?? defaultWindow(tz, now);
  const occ = (await listOccurrencesForMember(auth.workspace, auth.sub, new Date(win.from_utc), new Date(win.to_utc)))
    .slice().sort((a, b) => +new Date(a.occurrence_start_utc) - +new Date(b.occurrence_start_utc));
  if (occ.length === 0) return { kind: "answer", intent: "list_events", via, message: `${win.label}沒有排定的會議或行程。`, data: { window: win, events: [] } };
  const lines = occ.slice(0, 10).map((o) => `• ${fmtDay(o.occurrence_start_utc, tz)} ${fmtTime(o.occurrence_start_utc, tz)} ${o.title}${o.source === "agent" ? " ✨" : ""}`);
  const more = occ.length > 10 ? `\n…還有 ${occ.length - 10} 筆` : "";
  return { kind: "answer", intent: "list_events", via, message: `${win.label}有 ${occ.length} 個會議/行程：\n${lines.join("\n")}${more}`, data: { window: win, events: occ } };
}

async function answerCount(auth: AuthContext, text: string, tz: string, now: Date, via: string): Promise<AgentReply> {
  const win = resolveTimeWindow(text, tz, now) ?? defaultWindow(tz, now);
  const occ = await listOccurrencesForMember(auth.workspace, auth.sub, new Date(win.from_utc), new Date(win.to_utc));
  const n = occ.length;
  const busy = n >= 5 ? "行程偏滿" : n === 0 ? "很空" : "還算輕鬆";
  return { kind: "answer", intent: "count_events", via, message: `${win.label}共有 ${n} 個會議/行程，${busy}。`, data: { window: win, count: n } };
}

async function answerFree(auth: AuthContext, text: string, tz: string, now: Date, via: string): Promise<AgentReply> {
  const win = resolveTimeWindow(text, tz, now) ?? defaultWindow(tz, now);
  const { slots } = await computeAvailability(auth.workspace, { from_utc: win.from_utc, to_utc: win.to_utc, duration_minutes: 60, max_results: 5, member_ids: [auth.sub] });
  if (slots.length === 0) return { kind: "answer", intent: "find_free", via, message: `${win.label}找不到 1 小時的空檔。`, data: { window: win, slots: [] } };
  const lines = slots.map((s) => `• ${fmtDay(s.start_utc, tz)} ${fmtTime(s.start_utc, tz)}–${fmtTime(s.end_utc, tz)}`);
  return { kind: "answer", intent: "find_free", via, message: `${win.label}可用的空檔（1 小時）：\n${lines.join("\n")}`, data: { window: win, slots } };
}

async function answerListPending(auth: AuthContext, via: string, tz: string): Promise<AgentReply> {
  const pending = await listPendingForMember(auth.workspace, auth.sub);
  if (pending.length === 0) return { kind: "answer", intent: "list_pending", via, message: "目前沒有待你回覆的邀請 🎉", data: { pending: [] } };
  const lines = pending.map((p) => `• ${fmtDay(p.start_utc, tz)} ${fmtTime(p.start_utc, tz)} ${p.title}`);
  return { kind: "answer", intent: "list_pending", via, message: `你有 ${pending.length} 個待回覆的邀請：\n${lines.join("\n")}\n可到右上角鈴鐺一鍵回覆。`, data: { pending } };
}

// ---- 排會分支：轉委員會 ----

async function doSchedule(auth: AuthContext, text: string, tz: string, now: Date, model: ChatModel, via: string): Promise<AgentReply> {
  const state = await runCalendarCommittee(
    auth,
    { task_description: text, reference_now_utc: now.toISOString(), default_timezone: tz, confirm: false },
    { model },
  );
  if (state.status === "booked") return { kind: "scheduled", intent: "schedule", via, message: "已為你安排完成。", data: state.result };
  if (state.status === "needs_decision") {
    // 一鍵確認：有可行 booking_plan 時簽 option_token，前端顯示「確認」鈕帶 token 回來免重跑圖。
    let option_token: string | undefined;
    if (state.booking_plan?.resource_id && state.candidate) {
      const { signOptionToken } = await import("../option_token.js");
      const { withWorkspace } = await import("../../db/pool.js");
      const calId = await withWorkspace(auth.workspace, async (c) =>
        (await c.query(`SELECT id FROM calendars ORDER BY created_at LIMIT 1`)).rows[0]?.id ?? "",
      );
      option_token = signOptionToken({
        workspace: auth.workspace,
        calendar_id: calId,
        attendees: state.attendees,
        resource_id: state.booking_plan.resource_id,
        needs_handover: state.booking_plan.needs_handover,
        actual_start_utc: state.booking_plan.actual_start_utc,
        actual_end_utc: state.booking_plan.actual_end_utc,
        booking_start_utc: state.booking_plan.start_utc,
        booking_end_utc: state.booking_plan.end_utc,
        title: text.slice(0, 60),
        timezone: tz,
      });
    }
    return {
      kind: "needs_decision", intent: "schedule", via,
      message: state.message ?? "已擬好方案，請確認後我再正式排入。",
      data: { options: state.options, ...(option_token ? { option_token } : {}) },
    };
  }
  return { kind: "error", intent: "schedule", via, message: state.message ?? "無法完成排程，請補充時間或與會者資訊。" };
}

/** 一鍵確認：帶 option_token 直接落實（免重跑委員會）。 */
export async function confirmSchedule(auth: AuthContext, optionToken: string): Promise<AgentReply> {
  const { verifyOptionToken, OptionTokenError } = await import("../option_token.js");
  const { commitSchedulingPlan } = await import("../service.js");
  let claims;
  try {
    claims = verifyOptionToken(optionToken, auth.workspace);
  } catch (e) {
    if (e instanceof OptionTokenError) return { kind: "error", intent: "schedule", message: "確認連結已失效，請重新提出需求。" };
    throw e;
  }
  const committed = await commitSchedulingPlan(auth, {
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
  return { kind: "scheduled", intent: "schedule", message: "已為你正式排入行事曆。", data: { event: committed.event, booking: committed.booking } };
}
