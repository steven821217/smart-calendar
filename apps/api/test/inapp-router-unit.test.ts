import { describe, it, expect, beforeEach } from "vitest";
import { routeMessage, rulesFallback } from "../src/agents/inapp/router.js";
import { clearRouteCache } from "../src/agents/inapp/route-cache.js";
import type { ChatModel } from "../src/agents/llm.js";

/**
 * Agent-first 路由單元測（純函式，免 DB）。
 * 驗證：
 *  - 第一層由 agent 決定：agent 的 intent 被採用、via='agent'（不被規則覆蓋）。
 *  - agent 抽的 spec 經 normalizeSpec 清洗（髒 null → 真 null）。
 *  - agent（LLM）不可用時才規則兜底：via='rules-fallback'。
 */

const ROUTE_DEFAULTS = {
  anchor: "none" as const,
  weekday_from: null,
  weekday_to: null,
  daypart: "any" as const,
  filter_keyword: null,
  group_name: null,
  order: "none" as const,
  person_name: null,
  duration_minutes: null,
  search_range: "future" as const,
};

/** 內容感知 stub，模擬真實 LLM 的 family → function 兩層回答。 */
function agentStub(route: Record<string, unknown>): ChatModel {
  return {
    async invokeStructured(schema, _msgs) {
      const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
      if (shape && "family" in shape) {
        const i = String(route.intent ?? "list_events");
        const family = ["find_free"].includes(i) ? "availability"
          : ["list_members", "events_with_person"].includes(i) ? "people"
            : ["count_events", "compare_load", "stats"].includes(i) ? "analytics"
              : ["schedule", "reschedule", "cancel", "respond_rsvp"].includes(i) ? "mutation"
                : i === "out_of_scope" ? "out_of_scope" : "agenda";
        return {
          family, request_count: "one", secondary_family: null, confidence: "high", ambiguity: "none",
          requires_context: false, subject_scope: family === "people" ? "team" : "own", evidence_spans: [],
        } as never;
      }
      if (shape && "intent" in shape) return route as never;
      return {} as never;
    },
  };
}

const throwing: ChatModel = {
  async invokeStructured() {
    throw new Error("LLM down");
  },
};

// route 快取跨測試會污染（key=問句），每個測試前清空。
beforeEach(() => clearRouteCache());

describe("agent-first：第一層由 agent 決定", () => {
  it("agent 判 schedule → 採用 agent 的 intent，via='agent'", async () => {
    const r = await routeMessage("幫我安排跟客戶碰面", agentStub({ intent: "schedule", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("schedule");
    expect(r.via).toBe("agent");
  });

  it("agent 判 list_members → 採用（過去規則易把『有哪些人』誤判成 list_events）", async () => {
    const r = await routeMessage("Alpha 那組有哪些人", agentStub({ intent: "list_members", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("list_members");
    expect(r.via).toBe("agent");
  });

  it("agent 判 find_free 並帶 daypart/anchor → spec 帶回", async () => {
    const r = await routeMessage("明天下午找得到空檔嗎", agentStub({
      intent: "find_free", ...ROUTE_DEFAULTS, anchor: "tomorrow", daypart: "afternoon",
    }));
    expect(r.intent).toBe("find_free");
    expect(r.spec.anchor).toBe("tomorrow");
    expect(r.spec.daypart).toBe("afternoon");
    expect(r.via).toBe("agent");
  });

  it("agent 回髒 null 字串 → normalizeSpec 清成真 null", async () => {
    const r = await routeMessage("這週有哪些會", agentStub({
      intent: "list_events", ...ROUTE_DEFAULTS, anchor: "this_week", filter_keyword: ":null", group_name: "none",
    }));
    expect(r.spec.filter_keyword).toBeNull();
    expect(r.spec.group_name).toBeNull();
  });

  it("agent 回非法 intent → 安全降級為 list_events（仍 via='agent'，不卡死）", async () => {
    const r = await routeMessage("嗯", agentStub({ intent: "garbage", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("list_events");
    expect(r.via).toBe("agent");
  });
});

describe("agent 不可用 → 規則兜底（via='rules-fallback'）", () => {
  it("LLM 例外 → 用規則分類，via 標記兜底", async () => {
    // 含實體 → 走模型路徑（cascade tier-0 只承接無實體的容易輸入）
    const r = await routeMessage("產品週會明天有哪些安排", throwing);
    expect(r.intent).toBe("list_events");
    expect(r.via).toBe("rules-fallback");
  });

  it("LLM 例外 + 規則也判不出 → 預設 list_events（絕不卡死）", async () => {
    const r = await routeMessage("嗯嗯好喔", throwing);
    expect(r.intent).toBe("list_events");
    expect(r.via).toBe("rules-fallback");
  });

  it("rulesFallback 直接呼叫：schedule 關鍵字 → schedule", () => {
    const r = rulesFallback("幫我約明天開會");
    expect(r.intent).toBe("schedule");
    expect(r.via).toBe("rules-fallback");
  });
});

describe("高精度 backstop（agent 判完再覆核極明確措辭）", () => {
  it("agent 誤判 list_events，但『待處理的邀請』極明確 → 覆核成 list_pending", async () => {
    const r = await routeMessage("有沒有待處理的邀請", agentStub({ intent: "list_events", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("list_pending");
    expect(r.via).toBe("agent+backstop");
  });

  it("split 措辭『待我回覆』也被 backstop 抓到 → list_pending", async () => {
    const r = await routeMessage("有沒有待我回覆的邀請", agentStub({ intent: "list_events", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("list_pending");
    expect(r.via).toBe("agent+backstop");
  });

  it("agent 誤判 list_events，但『有沒有空』極明確 → 覆核成 find_free", async () => {
    const r = await routeMessage("產品週會前後有沒有空", agentStub({ intent: "list_events", ...ROUTE_DEFAULTS, anchor: "today", daypart: "afternoon" }));
    expect(r.intent).toBe("find_free");
    expect(r.via).toBe("agent+backstop");
  });

  it("agent 誤判 list_events，但『幾個/忙不忙』極明確 → 覆核成 count_events", async () => {
    const r = await routeMessage("今天忙不忙", agentStub({ intent: "list_events", ...ROUTE_DEFAULTS, anchor: "today" }));
    expect(r.intent).toBe("count_events");
    expect(r.via).toBe("agent+backstop");
  });

  it("agent 判對時 backstop 不動手（via 保持 agent）", async () => {
    const r = await routeMessage("產品週會當天有什麼會", agentStub({ intent: "list_events", ...ROUTE_DEFAULTS, anchor: "tomorrow" }));
    expect(r.intent).toBe("list_events");
    expect(r.via).toBe("agent");
  });

  it("backstop 不把查詢改成 schedule，也不碰 agent 判的 schedule", async () => {
    const r = await routeMessage("幫我約客戶明天碰面", agentStub({ intent: "schedule", ...ROUTE_DEFAULTS, anchor: "tomorrow" }));
    expect(r.intent).toBe("schedule");
    expect(r.via).toBe("agent");
  });

  it("agent 誤判 list_events，但『那隊都有誰』是成員查詢 → 覆核成 list_members", async () => {
    const r = await routeMessage("Alpha 那隊都有誰", agentStub({ intent: "list_events", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("list_members");
    expect(r.via).toBe("agent+backstop");
  });

  it("『這組現在都由誰在跑』→ list_members backstop", async () => {
    const r = await routeMessage("這組現在都由誰在跑", agentStub({ intent: "list_events", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("list_members");
    expect(r.via).toBe("agent+backstop");
  });

  it("成員 backstop 不誤傷『明天有誰的會』（只有問人、無群體指涉 → 不改）", async () => {
    const r = await routeMessage("明天有什麼客戶的會", agentStub({ intent: "list_events", ...ROUTE_DEFAULTS, anchor: "tomorrow" }));
    expect(r.intent).toBe("list_events");
    expect(r.via).toBe("agent");
  });

  it("忙碌程度比較措辭 → compare_load（不可誤走找空檔）", async () => {
    const r = await routeMessage("下週會不會比較輕鬆", agentStub({ intent: "find_free", ...ROUTE_DEFAULTS, anchor: "next_week" }));
    expect(r.intent).toBe("compare_load");
  });

  it("『我最忙星期幾』→ stats backstop（先於 count 的『幾個』）", async () => {
    const r = await routeMessage("我最忙的是星期幾", agentStub({ intent: "list_events", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("stats");
    expect(r.via).toBe("agent+backstop");
  });

  it("『這週比上週忙嗎』→ compare_load backstop（先於 count 的『忙嗎』）", async () => {
    const r = await routeMessage("這週比上週忙嗎", agentStub({ intent: "count_events", ...ROUTE_DEFAULTS, anchor: "this_week" }));
    expect(r.intent).toBe("compare_load");
    expect(r.via).toBe("agent+backstop");
  });

  it("out_of_scope 安全網：『今天天氣如何』時間詞+非日曆名詞 → 尊重 out_of_scope（不誤放行）", async () => {
    const r = await routeMessage("今天天氣如何", agentStub({ intent: "out_of_scope", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("out_of_scope");
    expect(r.via).toBe("agent");
  });

  it("out_of_scope 安全網：含日曆名詞『會議』→ 覆核放行成查詢（寧可多查不誤擋）", async () => {
    const r = await routeMessage("我今天有什麼客戶會議", agentStub({ intent: "out_of_scope", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("list_events");
    expect(r.via).toBe("agent+backstop");
  });

  it("14B 判 out_of_scope 且確實非日曆（寫詩）→ 保持 out_of_scope", async () => {
    const r = await routeMessage("幫我寫一首詩", agentStub({ intent: "out_of_scope", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("out_of_scope");
    expect(r.via).toBe("agent");
  });

  it("『接下來有啥事』→ next_event backstop", async () => {
    const r = await routeMessage("接下來有啥事", agentStub({ intent: "list_events", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("next_event");
    expect(r.via).toBe("agent+backstop");
  });

  it("next_event guard：『接下來三天有幾個會』不誤判成 next_event（是 count/list）", async () => {
    const r = await routeMessage("接下來三天有幾個會", agentStub({ intent: "count_events", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("count_events"); // 帶「幾個/N天」→ 不被 next_event 搶走
  });

  it("『禮拜五排滿了沒』→ count_events backstop", async () => {
    const r = await routeMessage("禮拜五排滿了沒", agentStub({ intent: "list_events", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("count_events");
    expect(r.via).toBe("agent+backstop");
  });

  it("『我最近是不是很閒』→ count_events backstop", async () => {
    const r = await routeMessage("我最近是不是很閒", agentStub({ intent: "list_events", ...ROUTE_DEFAULTS }));
    expect(r.intent).toBe("count_events");
    expect(r.via).toBe("agent+backstop");
  });
});

describe("群組感知 backstop（點名真實群組 + 問負責人）", () => {
  const GROUPS = ["產品團隊", "Alpha 小隊"];

  it("『產品團隊現在誰是負責人』帶群組清單 → 覆核成 list_members", async () => {
    const r = await routeMessage(
      "產品團隊現在誰是負責人",
      agentStub({ intent: "list_events", ...ROUTE_DEFAULTS, group_name: "產品團隊" }),
      GROUPS,
    );
    expect(r.intent).toBe("list_members");
    expect(r.via).toBe("agent+backstop");
  });

  it("同一句沒帶群組清單也能修正（『團隊』本身已是群體指涉，靠『誰是負責人』補齊問人語意）", async () => {
    const r = await routeMessage(
      "產品團隊現在誰是負責人",
      agentStub({ intent: "list_events", ...ROUTE_DEFAULTS, group_name: "產品團隊" }),
    );
    expect(r.intent).toBe("list_members");
    expect(r.via).toBe("agent+backstop");
  });

  it("群組名不含『團隊/小隊』等通用詞時，才真正需要群組清單才判得出", async () => {
    const withList = await routeMessage(
      "Bravo 現在誰是負責人",
      agentStub({ intent: "list_events", ...ROUTE_DEFAULTS }),
      ["Bravo"],
    );
    expect(withList.intent).toBe("list_members");
    expect(withList.via).toBe("agent+backstop");

    clearRouteCache();
    const withoutList = await routeMessage(
      "Bravo 現在誰是負責人",
      agentStub({ intent: "list_events", ...ROUTE_DEFAULTS }),
    );
    expect(withoutList.intent).toBe("list_events"); // 無依據 → 尊重 agent，不亂改
    expect(withoutList.via).toBe("agent");
  });

  it("群組名 + 問人，但問的是會議本身 → 不搶成員名單（留給 event_detail）", async () => {
    const r = await routeMessage(
      "明天產品團隊的會議有誰要來",
      agentStub({ intent: "event_detail", ...ROUTE_DEFAULTS, anchor: "tomorrow" }),
      GROUPS,
    );
    expect(r.intent).toBe("event_detail");
    expect(r.via).toBe("agent");
  });

  it("route 快取依群組指紋分槽：不同 workspace 群組不互相命中", async () => {
    const rA = await routeMessage(
      "Bravo 現在誰是負責人",
      agentStub({ intent: "list_events", ...ROUTE_DEFAULTS }),
      ["Bravo"],
    );
    const rB = await routeMessage(
      "Bravo 現在誰是負責人",
      agentStub({ intent: "list_events", ...ROUTE_DEFAULTS }),
      [],
    );
    expect(rA.intent).toBe("list_members"); // 有該群組 → 覆核
    expect(rB.intent).toBe("list_events"); // 無該群組 → 不覆核，且未誤用 A 的快取
  });
});

describe("誤判守門（群組當成人、無位移訊號的改期）", () => {
  const GROUPS = ["產品團隊", "Alpha 小隊"];

  it("『這禮拜有沒有跟產品團隊的會』不可被當成問人（cascade 直接以既有群組名確定性處理）", async () => {
    const r = await routeMessage(
      "這禮拜有沒有跟產品團隊的會",
      agentStub({ intent: "events_with_person", ...ROUTE_DEFAULTS, anchor: "this_week", person_name: "產品團隊" }),
      ["產品團隊"],
    );
    expect(r.intent).toBe("list_events");
    expect(r.spec.group_name).toBe("產品團隊");
    expect(r.spec.person_name).toBeNull();
    // 這句整體可被確定性解析（時間詞＋既有群組名＋虛詞）→ 不必付模型呼叫的延遲
    expect(r.via).toBe("rules-cascade");
  });

  it("真的問某個人（無群組語意）→ 保持 events_with_person", async () => {
    const r = await routeMessage(
      "我跟 Mia 下次什麼時候見",
      agentStub({ intent: "events_with_person", ...ROUTE_DEFAULTS, person_name: "Mia" }),
      GROUPS,
    );
    expect(r.intent).toBe("events_with_person");
    expect(r.via).toBe("agent");
  });

  it("『幫我把週五的專案同步會排一下』無位移訊號 → 覆核成 schedule（不是改期）", async () => {
    const r = await routeMessage(
      "幫我把週五的專案同步會排一下",
      agentStub({ intent: "reschedule", ...ROUTE_DEFAULTS }),
    );
    expect(r.intent).toBe("schedule");
    expect(r.via).toBe("agent+backstop");
  });

  it("有明確位移訊號『改到』→ 保持 reschedule", async () => {
    const r = await routeMessage(
      "把明天的會改到後天下午",
      agentStub({ intent: "reschedule", ...ROUTE_DEFAULTS, anchor: "tomorrow", to_anchor: "day_after_tomorrow", to_daypart: "afternoon" }),
    );
    expect(r.intent).toBe("reschedule");
    expect(r.via).toBe("agent");
  });

  it("『週會挪到下午三點』→ 保持 reschedule", async () => {
    const r = await routeMessage(
      "週會挪到下午三點",
      agentStub({ intent: "reschedule", ...ROUTE_DEFAULTS, to_daypart: "afternoon" }),
    );
    expect(r.intent).toBe("reschedule");
    expect(r.via).toBe("agent");
  });

  it("只有『改一下』也算變更訊號 → 保持 reschedule（由後端追問新時間）", async () => {
    const r = await routeMessage(
      "把明天的會議改一下",
      agentStub({ intent: "reschedule", ...ROUTE_DEFAULTS, anchor: "tomorrow" }),
    );
    expect(r.intent).toBe("reschedule");
    expect(r.via).toBe("agent");
  });

  it("cancel 不受改期守門影響（取消不需要位移訊號）", async () => {
    const r = await routeMessage(
      "取消明天的產品週會",
      agentStub({ intent: "cancel", ...ROUTE_DEFAULTS, anchor: "tomorrow", filter_keyword: "產品週會" }),
    );
    expect(r.intent).toBe("cancel");
    expect(r.via).toBe("agent");
  });
});

describe("router prompt 衛生（不得注入孤立範例問句）", () => {
  it("兩層呼叫都只有 system + 使用者這一句", async () => {
    const batches: Array<Array<{ role: string; content: string }>> = [];
    const spy: ChatModel = {
      async invokeStructured(schema, msgs) {
        batches.push(msgs.map((m) => ({ role: m.role, content: m.content })));
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
        if (shape && "family" in shape) {
          return {
            family: "agenda", secondary_family: null, confidence: "high", ambiguity: "none",
            requires_context: false, subject_scope: "own", evidence_spans: ["明天", "會議"],
          } as never;
        }
        return { intent: "list_events", ...ROUTE_DEFAULTS, anchor: "tomorrow" } as never;
      },
    };
    // 含實體 → 確定會走兩層模型呼叫（容易輸入會被 cascade tier-0 接走）
    await routeMessage("明天產品週會有哪些安排", spy);
    expect(batches).toHaveLength(2);
    for (const seen of batches) {
      expect(seen).toHaveLength(2);
      expect(seen[0].role).toBe("system");
      expect(seen[1]).toEqual({ role: "human", content: "明天產品週會有哪些安排" });
      expect(seen.some((m) => m.content === "今天有什麼會")).toBe(false);
    }
  });
});


describe("14B 分層 function routing", () => {
  it("第一層選 analytics 後，第二層只看 analytics functions 並同時抽 slots", async () => {
    let secondLayerOptions: string[] = [];
    let calls = 0;
    const model: ChatModel = {
      async invokeStructured(schema) {
        calls++;
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
        if (shape && "family" in shape) {
          return {
            family: "analytics", request_count: "one", confidence: "high",
            requires_context: false, subject_scope: "own", evidence_spans: ["忙不忙"],
          } as never;
        }
        const intentSchema = shape?.intent as { options?: string[] } | undefined;
        if (intentSchema?.options) secondLayerOptions = intentSchema.options;
        return { intent: "count_events", ...ROUTE_DEFAULTS, confidence: "high", ambiguity: "none", secondary_intent: null, filter_kind: "none", evidence_spans: ["忙不忙"] } as never;
      },
    };
    const r = await routeMessage("明天忙不忙", model);
    expect(calls).toBe(2);
    expect(secondLayerOptions).toEqual(["count_events", "compare_load", "stats", "list_events", "list_members"]);
    expect(r.intent).toBe("count_events");
  });
});


describe("跨欄位 intent/spec 一致性", () => {
  it("指定下週一的『最早』不可忽略日期走全域 next_event", async () => {
    const r = await routeMessage(
      "下週一最早排什麼",
      agentStub({
        intent: "next_event", ...ROUTE_DEFAULTS,
        anchor: "next_week", weekday_from: 0, weekday_to: 0, order: "first",
      }),
    );
    expect(r.intent).toBe("list_events");
    expect(r.spec.anchor).toBe("next_week");
    expect(r.spec.weekday_from).toBe(0);
    expect(r.spec.order).toBe("first");
  });
});


describe("明確 scope 高於舊 backstop", () => {
  it("『沒有要看我的行事曆』不因含日曆二字被放回 list_events", async () => {
    const model: ChatModel = {
      async invokeStructured(schema) {
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
        if (shape && "family" in shape) return {
          family: "agenda", request_count: "one", confidence: "high", requires_context: false,
          subject_scope: "none", evidence_spans: ["沒有要看我的行事曆"],
        } as never;
        return {
          intent: "out_of_scope", ...ROUTE_DEFAULTS, confidence: "high", ambiguity: "none",
          secondary_intent: null, filter_kind: "none", evidence_spans: ["沒有要看我的行事曆"],
        } as never;
      },
    };
    const r = await routeMessage("幫會議簡報寫結尾，沒有要看我的行事曆", model);
    expect(r.intent).toBe("out_of_scope");
    expect(r.via).toBe("agent");
  });
});


describe("Planner：multiple 才分解，最多 3 個子任務", () => {
  it("像多需求的句子直接先跑 Planner，省掉整句 family 呼叫", async () => {
    let calls = 0;
    const model: ChatModel = {
      async invokeStructured(schema) {
        calls++;
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
        if (shape && "tasks" in shape) return {
          tasks: [
            { request: "列出明天的會議", family: "agenda", subject_scope: "own", evidence_spans: ["明天的會議"] },
            { request: "找明天一小時的空檔", family: "availability", subject_scope: "own", evidence_spans: ["一小時的空檔"] },
          ],
        } as never;
        throw new Error("拆解成功後不應再呼叫 family 或 specialist");
      },
    };
    const r = await routeMessage("列出明天的會議，另外找一小時的空檔", model);
    expect(calls).toBe(1);
    expect(r.subtasks).toEqual([
      { request: "列出明天的會議", family: "agenda", subject_scope: "own" },
      { request: "找明天一小時的空檔", family: "availability", subject_scope: "own" },
    ]);
    expect(r.semantic?.ambiguity).toBe("multiple_requests");
  });

  it("Planner evidence 不可信且為唯讀需求 → 不執行計畫，退回單一作答", async () => {
    const model: ChatModel = {
      async invokeStructured(schema) {
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
        if (shape && "family" in shape) return {
          family: "existing_events", request_count: "multiple", confidence: "high", requires_context: false,
          subject_scope: "own", evidence_spans: ["明天", "空檔"],
        } as never;
        if (shape && "tasks" in shape) return {
          tasks: [
            { request: "列出明天行程", family: "existing_events", subject_scope: "own", evidence_spans: ["不存在的證據"] },
            { request: "找空檔", family: "free_time", subject_scope: "own", evidence_spans: ["空檔"] },
          ],
        } as never;
        return { intent: "list_events", ...ROUTE_DEFAULTS, anchor: "tomorrow" } as never;
      },
    };
    const r = await routeMessage("明天有什麼，另外找空檔", model);
    expect(r.subtasks).toBeUndefined();
    expect(r.semantic?.ambiguity).toBe("none");
    expect(["list_events", "find_free"]).toContain(r.intent);
  });

  it("Planner evidence 不可信且涉及修改日曆 → 仍要求拆句，不退回作答", async () => {
    const model: ChatModel = {
      async invokeStructured(schema) {
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
        if (shape && "family" in shape && "request_count" in shape) return {
          family: "modify_calendar", request_count: "multiple", confidence: "high", requires_context: false,
          subject_scope: "own", evidence_spans: ["取消"],
        } as never;
        if (shape && "tasks" in shape) return {
          tasks: [
            { request: "查站立會", family: "existing_events", subject_scope: "own", evidence_spans: ["不存在"] },
            { request: "取消站立會", family: "modify_calendar", subject_scope: "own", evidence_spans: ["幻想"] },
          ],
        } as never;
        if (shape && "family" in shape) return { family: "mutation", evidence_spans: ["取消"] } as never;
        return { intent: "cancel", ...ROUTE_DEFAULTS } as never;
      },
    };
    const r = await routeMessage("查站立會，然後取消它", model);
    expect(r.subtasks).toBeUndefined();
    expect(r.semantic?.ambiguity).toBe("multiple_requests");
  });
});


describe("PreToolUse family verifier", () => {
  it("把『留時間工作』從 mutation 修正為 availability，再交給 find_free specialist", async () => {
    const model: ChatModel = {
      async invokeStructured(schema) {
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
        if ("family" in shape && "request_count" in shape) return {
          family: "mutation", request_count: "one", confidence: "high", requires_context: false,
          subject_scope: "own", evidence_spans: ["留兩小時"],
        } as never;
        if ("family" in shape) return { family: "availability", evidence_spans: ["留兩小時"] } as never;
        if ("intent" in shape && !("anchor" in shape)) return {
          intent: "find_free", confidence: "high", ambiguity: "none", evidence_spans: ["留兩小時"],
        } as never;
        return {
          intent: "find_free", ...ROUTE_DEFAULTS, anchor: "next_week", weekday_from: 0, weekday_to: 0,
          duration_minutes: 120, confidence: "high", ambiguity: "none", secondary_intent: null,
          filter_kind: "none", evidence_spans: ["下週一", "留兩小時"],
        } as never;
      },
    };
    const r = await routeMessage("下週一留兩小時給我工作", model);
    expect(r.intent).toBe("find_free");
    expect(r.spec.duration_minutes).toBe(120);
  });
});



describe("requested_detail 跨欄位契約", () => {
  it("即使 family/selector 誤判 analytics，Slot Extractor 指出單一事件時長後仍改走 event_detail", async () => {
    const model: ChatModel = {
      async invokeStructured(schema) {
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
        if ("family" in shape && "request_count" in shape) return {
          family: "analytics", request_count: "one", confidence: "high", calendar_operation_requested: true,
          requires_context: false, subject_scope: "own", evidence_spans: ["產品會議", "多久"],
        } as never;
        if ("family" in shape) return {
          family: "analytics", target_evidence: "產品會議", evidence_spans: ["產品會議", "多久"],
        } as never;
        if ("is_event_subject" in shape) return { is_event_subject: true, evidence_spans: ["產品會議"] } as never;
        if ("intent" in shape && !("anchor" in shape)) return {
          intent: "count_events", confidence: "high", ambiguity: "none", evidence_spans: ["多久"],
        } as never;
        return {
          intent: "count_events", ...ROUTE_DEFAULTS, filter_keyword: "產品會議",
          requested_detail: "duration", confidence: "high", ambiguity: "none",
          secondary_intent: null, filter_kind: "event_subject", evidence_spans: ["產品會議", "多久"],
        } as never;
      },
    };
    const r = await routeMessage("產品會議會開多久", model);
    expect(r.intent).toBe("event_detail");
    expect(r.spec.filter_keyword).toBe("產品會議");
  });
});


describe("count_target 跨欄位契約（數人 vs 數行程）", () => {
  function model(countTarget: "events" | "people", intent: string): ChatModel {
    return {
      async invokeStructured(schema) {
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
        if ("family" in shape && "request_count" in shape) return {
          family: "aggregate_stats", request_count: "one", confidence: "high",
          requires_context: false, subject_scope: "team", evidence_spans: ["幾個"],
        } as never;
        if ("family" in shape) return { family: "analytics", target_evidence: null, evidence_spans: ["幾個"] } as never;
        return {
          intent, ...ROUTE_DEFAULTS, group_name: "Alpha 小隊", count_target: countTarget,
          confidence: "high", ambiguity: "none", secondary_intent: null,
          filter_kind: "none", evidence_spans: ["幾個"],
        } as never;
      },
    };
  }

  it("數的是人 → 即使 selector 選了 count_events 也改走 list_members", async () => {
    const r = await routeMessage("Alpha 小隊裡有幾個人", model("people", "count_events"), ["Alpha 小隊"]);
    expect(r.intent).toBe("list_members");
  });

  it("數的是行程 → 保持 count_events，不被人數示例帶偏", async () => {
    const r = await routeMessage("Alpha 小隊明天有幾個會", model("events", "count_events"), ["Alpha 小隊"]);
    expect(r.intent).toBe("count_events");
  });
});

describe("Planner evidence grounding 門檻", () => {
  it("同一 task 的證據可由原文成分重組（實測模型會輸出補全後的『明天下午』）", async () => {
    const model: ChatModel = {
      async invokeStructured(schema) {
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
        if ("family" in shape && "request_count" in shape) return {
          family: "existing_events", request_count: "multiple", confidence: "high",
          requires_context: false, subject_scope: "own", evidence_spans: ["明天上午"],
        } as never;
        if ("tasks" in shape) return {
          tasks: [
            { request: "列出明天上午的行程", family: "existing_events", subject_scope: "own", evidence_spans: ["明天上午"] },
            { request: "列出明天下午的行程", family: "existing_events", subject_scope: "own", evidence_spans: ["明天下午"] },
          ],
        } as never;
        return { intent: "list_events", ...ROUTE_DEFAULTS } as never;
      },
    };
    const r = await routeMessage("明天上午和下午分別列出行程", model);
    expect(r.subtasks?.length).toBe(2);
  });

  it("完全沒有逐字證據的 task 仍被剔除（防幻想任務）", async () => {
    const model: ChatModel = {
      async invokeStructured(schema) {
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
        if ("family" in shape && "request_count" in shape) return {
          family: "existing_events", request_count: "multiple", confidence: "high",
          requires_context: false, subject_scope: "own", evidence_spans: ["明天"],
        } as never;
        if ("tasks" in shape) return {
          tasks: [
            { request: "列出明天行程", family: "existing_events", subject_scope: "own", evidence_spans: ["明天"] },
            { request: "刪掉所有會議", family: "modify_calendar", subject_scope: "own", evidence_spans: ["幻想指令"] },
          ],
        } as never;
        return { intent: "list_events", ...ROUTE_DEFAULTS } as never;
      },
    };
    const r = await routeMessage("明天有什麼行程", model);
    expect(r.subtasks).toBeUndefined();
  });
});

describe("人名確定性覆核（workspace 成員名單）", () => {
  const personStub = (raw: Record<string, unknown>): ChatModel => ({
    async invokeStructured(schema) {
      const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
      if (shape && "family" in shape) {
        return { family: "existing_events", request_count: "one", confidence: "high", requires_context: false, subject_scope: "own", evidence_spans: [] } as never;
      }
      return raw as never;
    },
  });
  const PERSON_RAW = {
    anchor: "none", weekday_from: null, weekday_to: null, daypart: "any", filter_keyword: null,
    group_name: null, order: "all", person_name: null, duration_minutes: null, search_range: "future",
    requested_detail: "none", count_target: "none", confidence: "high", ambiguity: "none",
    filter_kind: "none", evidence_spans: [],
  };

  it("句中出現既有成員全名 → 補上 person_name 並改判查共同行程", async () => {
    const r = await routeMessage(
      "周雅婷參加了哪些會議呢",
      personStub({ function_name: "search_events", ...PERSON_RAW }),
      [],
      { people: ["周雅婷", "張美玲"] },
    );
    expect(r.spec.person_name).toBe("周雅婷");
    expect(r.intent).toBe("events_with_person");
  });

  it("點名單一行程的細節問題不可被改成查共同行程", async () => {
    const r = await routeMessage(
      "一對一：王大文 是幾點",
      personStub({ function_name: "event_detail", ...PERSON_RAW, filter_keyword: "一對一：王大文", evidence_spans: ["一對一：王大文"], requested_detail: "start_end" }),
      [],
      { people: ["王大文"] },
    );
    expect(r.intent).toBe("event_detail");
  });
});
