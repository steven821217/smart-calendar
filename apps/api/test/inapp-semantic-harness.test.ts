import { beforeEach, describe, expect, it } from "vitest";
import { durationMinutesFromText, normalizeSpec, orderFromText, reconcileSpec, subjectKeywordFromText } from "../src/agents/inapp/query-spec.js";
import { routeMessage } from "../src/agents/inapp/router.js";
import { clearRouteCache } from "../src/agents/inapp/route-cache.js";
import { clauseSegments, looksCompositional } from "../src/agents/inapp/clause-split.js";
import {
  applySemanticSpecContract,
  canonicalizePrimaryIntent,
  clarificationForSemanticRoute,
  discourseSignals,
  explicitlyDeclinesCalendarLookup,
  normalizeSemanticAssessment,
} from "../src/agents/inapp/semantic-harness.js";
import type { ChatModel } from "../src/agents/llm.js";

const SPEC = normalizeSpec({ intent: "list" });
const ROUTE_DEFAULTS = {
  anchor: "none", weekday_from: null, weekday_to: null, daypart: "any",
  filter_keyword: null, group_name: null, order: "none", person_name: null,
  duration_minutes: null, search_range: "future", to_anchor: null, to_weekday: null,
  to_daypart: "any", edit_scope: "this", rsvp_decision: null,
};

const modelWith = (value: Record<string, unknown>): ChatModel => ({
  async invokeStructured(schema) {
    const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
    if (shape && "family" in shape) {
      const i = String(value.intent ?? "list_events");
      const family = i === "count_events" ? "analytics" : i === "find_free" ? "availability" : "agenda";
      return {
        family, request_count: "one", secondary_family: null, confidence: value.confidence ?? "medium", ambiguity: "none",
        requires_context: false, subject_scope: "own", evidence_spans: value.evidence_spans ?? [],
      } as never;
    }
    return value as never;
  },
});

beforeEach(() => clearRouteCache());

describe("semantic harness：不是只驗 JSON 形狀，也驗語意證據", () => {
  it("只保留逐字出現在原文的 evidence；幻想證據會降低 high confidence", () => {
    const s = normalizeSemanticAssessment(
      {
        confidence: "high", ambiguity: "none", secondary_intent: null,
        evidence_spans: ["幫我瞄一下", "明兒個", "原文不存在"],
      },
      "幫我瞄一下明兒個是不是排很滿",
      "count_events",
    );
    expect(s.evidence_spans).toEqual(["幫我瞄一下", "明兒個"]);
    expect(s.invalid_evidence).toBe(true);
    expect(s.confidence).toBe("medium");
  });

  it("第二個獨立需求不會被單一 intent 靜默吞掉", () => {
    const s = normalizeSemanticAssessment(
      {
        confidence: "high", ambiguity: "none", secondary_intent: "find_free",
        evidence_spans: ["有哪些會", "找個空檔"],
      },
      "明天有哪些會，順便幫我找個空檔",
      "list_events",
    );
    expect(s.ambiguity).toBe("multiple_requests");
    expect(clarificationForSemanticRoute("list_events", SPEC, s)).toContain("查看行程");
    expect(clarificationForSemanticRoute("list_events", SPEC, s)).toContain("找空檔");
  });

  it("無法解析『把它取消』的指涉時先追問，不猜事件", () => {
    const s = normalizeSemanticAssessment(
      { confidence: "medium", ambiguity: "unresolved_reference", evidence_spans: ["它", "取消"] },
      "把它取消",
      "cancel",
    );
    expect(clarificationForSemanticRoute("cancel", SPEC, s)).toContain("沒有足夠上下文");
  });

  it("破壞性意圖缺目標時追問；一般自然口語 medium confidence 不過度追問", () => {
    const missing = normalizeSemanticAssessment(
      { confidence: "medium", ambiguity: "missing_target", evidence_spans: ["取消"] },
      "取消一下",
      "cancel",
    );
    expect(clarificationForSemanticRoute("cancel", SPEC, missing)).toContain("哪一個行程");

    const natural = normalizeSemanticAssessment(
      { confidence: "medium", ambiguity: "none", evidence_spans: ["瞄一下", "明兒個", "排很滿"] },
      "幫我瞄一下明兒個是不是排很滿",
      "count_events",
    );
    expect(clarificationForSemanticRoute("count_events", SPEC, natural)).toBeNull();
  });

  it("真正低信心且 unclear 才追問，不以錯字或長句本身當低信心", () => {
    const unclear = normalizeSemanticAssessment(
      { confidence: "low", ambiguity: "unclear", evidence_spans: ["嗯那個"] },
      "嗯那個",
      "list_events",
    );
    expect(clarificationForSemanticRoute("list_events", SPEC, unclear)).toContain("不太確定");
  });
});

describe("routeMessage semantic contract", () => {
  it("一次 structured call 同時產生 intent/spec/ambiguity/evidence", async () => {
    const r = await routeMessage(
      "勞駕幫我看看明兒個排得滿不滿",
      modelWith({
        intent: "count_events", ...ROUTE_DEFAULTS, anchor: "tomorrow",
        confidence: "medium", ambiguity: "none", secondary_intent: null,
        evidence_spans: ["看看", "明兒個", "滿不滿"],
      }),
    );
    expect(r.intent).toBe("count_events");
    expect(r.spec.anchor).toBe("tomorrow");
    expect(r.semantic).toMatchObject({
      confidence: "medium", ambiguity: "none", secondary_intent: null,
      evidence_spans: ["看看", "明兒個", "滿不滿"], invalid_evidence: false,
    });
  });

  it("舊 fixture 沒有 semantic 欄位仍安全降級，不破壞既有測試/快取", async () => {
    const r = await routeMessage(
      "明天有哪些客戶會議",
      modelWith({ intent: "list_events", ...ROUTE_DEFAULTS, anchor: "tomorrow" }),
    );
    expect(r.semantic).toMatchObject({ confidence: "medium", ambiguity: "none", evidence_spans: [] });
  });
});


describe("semantic reconciliation：以欄位角色與涵蓋關係取代單字黑名單", () => {
  it("specialized intent + list_events 是同一工作，不過度追問", () => {
    for (const primary of ["next_event", "event_detail", "find_free", "stats", "compare_load"] as const) {
      const s = normalizeSemanticAssessment(
        { confidence: "high", ambiguity: "multiple_requests", secondary_intent: "list_events", filter_kind: "none", evidence_spans: ["行程"] },
        "請看我的行程",
        primary,
      );
      expect(s.secondary_intent, primary).toBeNull();
      expect(s.ambiguity, primary).toBe("none");
      expect(clarificationForSemanticRoute(primary, { ...SPEC, filter_keyword: "行程" }, s), primary).toBeNull();
    }
  });

  it("count + list 統一選資訊較完整的 list primary", () => {
    expect(canonicalizePrimaryIntent("count_events", "list_events")).toBe("list_events");
    expect(canonicalizePrimaryIntent("count_events", "find_free")).toBe("count_events");
  });

  it("filter 的語意角色不是事件主題時清掉；legacy unknown 不誤傷", () => {
    const withFilter = normalizeSpec({ intent: "count", filter_keyword: "塞爆" });
    const noSubject = normalizeSemanticAssessment(
      { confidence: "high", ambiguity: "none", filter_kind: "none", evidence_spans: ["塞爆"] },
      "明天塞爆了沒",
      "count_events",
    );
    expect(applySemanticSpecContract(withFilter, noSubject).filter_keyword).toBeNull();

    const legacy = normalizeSemanticAssessment({}, "明天產品會有幾場", "count_events");
    expect(applySemanticSpecContract(normalizeSpec({ intent: "count", filter_keyword: "產品" }), legacy).filter_keyword).toBe("產品");
  });

  it("find_free 一律不帶用途型 filter，且自然中文時長由 deterministic parser 覆核", () => {
    const base = normalizeSpec({ intent: "find_free", filter_keyword: "做簡報", duration_minutes: 30 });
    const reconciled = reconcileSpec(base, "我想留一個半小時做簡報", []);
    expect(reconciled.filter_keyword).toBeNull();
    expect(reconciled.duration_minutes).toBe(90);
    expect(durationMinutesFromText("四十五分鐘就好")).toBe(45);
    expect(durationMinutesFromText("需要 1.5 hours")).toBe(90);
    expect(durationMinutesFromText("兩個半小時")).toBe(150);
  });

  it("引號只作為標示，不成為事件標題的一部分", () => {
    expect(normalizeSpec({ intent: "list", filter_keyword: "『產品』" }).filter_keyword).toBe("產品");
    expect(normalizeSpec({ intent: "list", filter_keyword: "\"客戶\"" }).filter_keyword).toBe("客戶");
  });

  it("粗粒度規則不會抹掉模型抽出的具體 weekday", () => {
    const s = reconcileSpec(
      normalizeSpec({ intent: "list", anchor: "this_week", weekday_from: 6, weekday_to: 6 }),
      "这周日有什么安排",
      [],
    );
    expect(s.anchor).toBe("this_week");
    expect(s.weekday_from).toBe(6);
    expect(s.weekday_to).toBe(6);
  });
});


describe("discourse safety net 與結構化排序", () => {
  it("多需求候選改由子句切分產生（不靠整句連接詞統計）", () => {
    // 依 arXiv:2603.28929：整句連接詞統計在 connector shift 下崩潰，改為子句分解。
    expect(clauseSegments("先處理 A，接著處理 B").length).toBeGreaterThanOrEqual(2);
    expect(clauseSegments("查 A，另外也處理 B").length).toBeGreaterThanOrEqual(2);
    // 寒暄子句不算需求，避免禮貌長句被誤判成多需求
    expect(clauseSegments("不好意思打擾，想請你整理明天下午的事項，謝謝").length).toBe(1);
    expect(looksCompositional("不好意思打擾，想請你整理明天下午的事項，謝謝")).toBe(false);
    expect(looksCompositional("後天有什麼，還有哪些邀請沒回")).toBe(true);
    // 分配型運算子即使只有一個子句也要拆（「上午和下午」是並列名詞片語）
    expect(looksCompositional("明天上午和下午分別列出行程")).toBe(true);
    expect(looksCompositional("明天下午有哪些會")).toBe(false);
    expect(looksCompositional("牙醫結束以後找空檔")).toBe(false);
  });

  it("無對話記憶時辨識句首指涉與『剛才提到』", () => {
    expect(discourseSignals("它幾點結束？").unresolvedReference).toBe(true);
    expect(discourseSignals("剛才提到的那場在哪？").unresolvedReference).toBe(true);
    expect(discourseSignals("剛才那場在哪？").unresolvedReference).toBe(true);
    expect(discourseSignals("之前那個會議室在哪？").unresolvedReference).toBe(true);
    expect(discourseSignals("前面講的都作廢，現在只問明天下午那場").unresolvedReference).toBe(false);
    expect(discourseSignals("前面講的都作廢，現在只問明天下午那場").discardsPriorContext).toBe(true);
    expect(discourseSignals("下一個行程是什麼？").unresolvedReference).toBe(false);
  });

  it("last 是 schema 內的排序值，完整列表仍用 none", () => {
    expect(normalizeSpec({ intent: "list", order: "last" }).order).toBe("last");
    expect(normalizeSpec({ intent: "list", order: "none" }).order).toBe("none");
  });

  it("封閉語法結構可補抽被漏掉的主題關鍵字", () => {
    expect(subjectKeywordFromText("有幾場專案同步會？")).toBe("專案同步會");
    expect(subjectKeywordFromText("大會議室被用在哪幾場會？")).toBe("大會議室");
    // 指示詞同位語與時長謂語
    expect(subjectKeywordFromText("技術債清理討論那場是什麼時候？")).toBe("技術債清理討論");
    expect(subjectKeywordFromText("季度預算檢討開多久")).toBe("季度預算檢討");
    expect(subjectKeywordFromText("週回顧多長？")).toBe("週回顧");
    expect(subjectKeywordFromText("客戶簡報排練多久")).toBe("客戶簡報排練");
    // 泛稱與時間詞不可被當成主題
    expect(subjectKeywordFromText("明天有幾個會？")).toBeNull();
  });

  it("補抽結果只是推測，reconcileSpec 不可直接寫進 spec", () => {
    // 錯字「會意」符合量詞結構但不是真主題；縮限與否必須由服務層依資料決定。
    const s = reconcileSpec(normalizeSpec({ intent: "count" }), "明天有幾個會意？", []);
    expect(s.filter_keyword).toBeNull();
  });

  it("疑問詞「哪」要求指認，不可被當成計數", () => {
    const asList = reconcileSpec(normalizeSpec({ intent: "count" }), "大會議室被用在哪幾場會", []);
    expect(asList.intent).toBe("list");
    const stillCount = reconcileSpec(normalizeSpec({ intent: "count" }), "明天有幾場會", []);
    expect(stillCount.intent).toBe("count");
  });

  it("跨時段範圍不可被縮成單一時段（「下午到晚上」）", () => {
    const s = reconcileSpec(normalizeSpec({ intent: "list", daypart: "afternoon" }), "明天下午到晚上都有什麼", []);
    expect(s.daypart).toBe("any");
    const single = reconcileSpec(normalizeSpec({ intent: "list", daypart: "any" }), "明天下午有哪些會", []);
    expect(single.daypart).toBe("afternoon");
  });

  it("最高級排序由後端確定性解析，不依賴 14B 選對 enum", () => {
    expect(orderFromText("明天壓軸行程叫什麼名字")).toBe("last");
    expect(orderFromText("明天最後一場是哪個")).toBe("last");
    expect(orderFromText("明天收工前最後要處理哪一件")).toBe("last");
    expect(orderFromText("明天最早那場幾點")).toBe("first");
    expect(orderFromText("明天第一場叫什麼")).toBe("first");
    expect(orderFromText("明天的行程按時間全部列給我")).toBeNull();
    const s = reconcileSpec(normalizeSpec({ intent: "list", order: "none" }), "明天壓軸行程叫什麼名字", []);
    expect(s.order).toBe("last");
  });
});

  it("尊重使用者明確聲明不是日曆查詢，但不誤傷被否定的天氣背景", () => {
    expect(explicitlyDeclinesCalendarLookup("替會議寫稿，不需要查我的日曆")).toBe(true);
    expect(explicitlyDeclinesCalendarLookup("替會議擬稿，不用查看我的行事曆")).toBe(true);
    expect(explicitlyDeclinesCalendarLookup("只潤飾文字，不必查看或操作行事曆")).toBe(true);
    expect(explicitlyDeclinesCalendarLookup("這不是日曆查詢，只是寫文章")).toBe(true);
    expect(explicitlyDeclinesCalendarLookup("不用查天氣，只看我的日曆")).toBe(false);
  });

  it("日曆類別複合詞不是事件標題 filter", () => {
    const s = reconcileSpec(normalizeSpec({ intent: "count", filter_keyword: "日曆項目" }), "後天有幾個日曆項目", []);
    expect(s.filter_keyword).toBeNull();
  });

  it("事件標題包含群組核心詞時，以事件為準不套用群組過濾", () => {
    const s = reconcileSpec(
      normalizeSpec({ intent: "list", filter_keyword: "產品週會" }),
      "產品週會有誰參加",
      ["產品團隊", "Alpha 小隊"],
    );
    expect(s.filter_keyword).toBe("產品週會");
    expect(s.group_name).toBeNull();
  });

  it("真的點名群組時仍套用群組過濾", () => {
    const s = reconcileSpec(
      normalizeSpec({ intent: "list", filter_keyword: null }),
      "產品團隊有哪些人",
      ["產品團隊", "Alpha 小隊"],
    );
    expect(s.group_name).toBe("產品團隊");
  });
