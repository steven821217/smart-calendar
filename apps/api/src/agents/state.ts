import { Annotation } from "@langchain/langgraph";

/** 解析後的時間窗（重用既有 parseEventFromText 的輸出換算而來）。 */
export type Timeframe = {
  from_utc: string;
  to_utc: string;
  duration_minutes: number;
};

/** 資源需求；vehicle 為應用層概念（對映 DB type=equipment，見 REQ-4）。 */
export type ResourceNeed = {
  kind: "vehicle" | "room" | "equipment" | "named";
  ref?: string; // 名稱關鍵字或具體資源名
};

export type NegotiationOption = {
  start_utc: string;
  end_utc: string;
  score: number;
};

export type BookingPlan = {
  resource_id: string;
  resource_name: string;
  needs_handover: boolean;
  // 寫入 resource_bookings 的區間（需交接資源含 buffer；否則等於實際使用）
  start_utc: string;
  end_utc: string;
  // 扣回 buffer 的實際使用時段
  actual_start_utc: string;
  actual_end_utc: string;
};

export type TraceEntry = { node: string; note: string; data?: unknown };

export type CommitteeStatus =
  | "pending"
  | "needs_clarification"
  | "needs_decision"
  | "booked"
  | "error";

export interface CommitteeState {
  // 輸入
  task_description: string;
  reference_now_utc: string;
  default_timezone: string;
  confirm: boolean;
  explain: boolean;
  // Coordinator 產出
  attendees: string[]; // membership id
  // 委派型參與者（Leader 幫 Member 排）：這些 member 落實時設 rsvp_status='pending'
  // 並各自產生 rsvp_token 觸發通知（feature-team-groups Req 2.2 / 3.1）。
  delegated_attendees: string[];
  resources: ResourceNeed[];
  timeframe: Timeframe | null;
  // Negotiator 產出
  candidate?: NegotiationOption;
  options: NegotiationOption[]; // 最多 3
  // Resource Manager 產出
  booking_plan?: BookingPlan;
  // 觀測性（功能 B/D）
  trace: TraceEntry[];
  // 終態
  status: CommitteeStatus;
  message?: string;
  code?: string;
  result?: unknown;
}

/** 覆寫 reducer：節點各自負責產出完整值，避免累加造成重複（design §3）。 */
function lastWins<T>(_old: T, next: T): T {
  return next;
}

/** trace 是唯一累加欄位：各節點各 append 自己的軌跡。 */
function appendTrace(old: TraceEntry[], next: TraceEntry[]): TraceEntry[] {
  return [...(old ?? []), ...(next ?? [])];
}

/**
 * LangGraph channels（A.4）。陣列型欄位除 trace 外皆用覆寫語意。
 */
export const CommitteeAnnotation = Annotation.Root({
  task_description: Annotation<string>({ reducer: lastWins, default: () => "" }),
  reference_now_utc: Annotation<string>({ reducer: lastWins, default: () => new Date().toISOString() }),
  default_timezone: Annotation<string>({ reducer: lastWins, default: () => "UTC" }),
  confirm: Annotation<boolean>({ reducer: lastWins, default: () => false }),
  explain: Annotation<boolean>({ reducer: lastWins, default: () => false }),

  attendees: Annotation<string[]>({ reducer: lastWins, default: () => [] }),
  delegated_attendees: Annotation<string[]>({ reducer: lastWins, default: () => [] }),
  resources: Annotation<ResourceNeed[]>({ reducer: lastWins, default: () => [] }),
  timeframe: Annotation<Timeframe | null>({ reducer: lastWins, default: () => null }),
  /** coordinator 抽出的行程標題（活動本身，不含時間與語氣詞）。 */
  event_title: Annotation<string | undefined>({ reducer: lastWins, default: () => undefined }),

  candidate: Annotation<NegotiationOption | undefined>({ reducer: lastWins, default: () => undefined }),
  options: Annotation<NegotiationOption[]>({ reducer: lastWins, default: () => [] }),

  booking_plan: Annotation<BookingPlan | undefined>({ reducer: lastWins, default: () => undefined }),

  trace: Annotation<TraceEntry[]>({ reducer: appendTrace, default: () => [] }),

  status: Annotation<CommitteeStatus>({ reducer: lastWins, default: () => "pending" }),
  message: Annotation<string | undefined>({ reducer: lastWins, default: () => undefined }),
  code: Annotation<string | undefined>({ reducer: lastWins, default: () => undefined }),
  result: Annotation<unknown>({ reducer: lastWins, default: () => undefined }),
});

export type CommitteeStateType = typeof CommitteeAnnotation.State;
