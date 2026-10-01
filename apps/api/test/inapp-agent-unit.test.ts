import { describe, it, expect } from "vitest";
import { classifyByRules, classifyIntent } from "../src/agents/inapp/intent.js";
import { resolveTimeWindow, defaultWindow, windowFromSpec } from "../src/agents/inapp/time-window.js";
import { normalizeSpec, reconcileSpec, type QuerySpec } from "../src/agents/inapp/query-spec.js";
import type { ChatModel } from "../src/agents/llm.js";

/**
 * 站內 agent harness 單元測（純函式，免 DB/LLM）。
 * 驗證「規則為主、model 兜底、時間一律後端算」對 14B 的保護確實成立。
 */

const TZ = "Asia/Taipei";
const NOW = new Date("2026-09-17T02:00:00Z"); // = 2026-09-17 10:00 Asia/Taipei（週四）

describe("意圖分類（規則優先）", () => {
  const cases: Array<[string, ReturnType<typeof classifyByRules>]> = [
    ["明天有會議嗎？", "list_events"],
    ["今天有什麼事", "list_events"],
    ["我下一個會議是什麼時候", "list_events"],
    ["這週我有幾個會", "count_events"],
    ["今天忙不忙", "count_events"],
    ["明天下午有空嗎", "find_free"],
    ["哪個時段是空的", "find_free"],
    ["有沒有人約我還沒回覆", "list_pending"],
    ["幫我約產品團隊明天下午開會", "schedule"],
    ["訂週四的公務車", "schedule"],
    ["我的member有誰", "list_members"],
    ["我的組員是誰", "list_members"],
    ["產品團隊有哪些人", "list_members"],
    ["誰在Alpha小隊", "list_members"],
  ];
  for (const [text, expected] of cases) {
    it(`「${text}」→ ${expected}`, () => {
      expect(classifyByRules(text)).toBe(expected);
    });
  }

  it("完全無關鍵字 → 規則回 null（交給 model 兜底）", () => {
    expect(classifyByRules("嗯嗯好喔")).toBeNull();
  });
});

describe("意圖分類 model 兜底（14B 壞掉也不卡死）", () => {
  const throwing: ChatModel = {
    async invokeStructured() {
      throw new Error("LLM down");
    },
  };
  it("規則判不出 + model 例外 → fallback 到預設意圖", async () => {
    const r = await classifyIntent("隨便講講", throwing, "list_events");
    expect(r.intent).toBe("list_events");
    expect(r.via).toBe("default");
  });

  it("規則命中時完全不呼叫 model", async () => {
    let called = false;
    const spy: ChatModel = {
      async invokeStructured() {
        called = true;
        return { intent: "schedule" } as never;
      },
    };
    const r = await classifyIntent("明天有會議嗎", spy);
    expect(r.via).toBe("rules");
    expect(r.intent).toBe("list_events");
    expect(called).toBe(false);
  });

  it("model 回非法值 → fallback（不採信壞輸出）", async () => {
    const bad: ChatModel = {
      async invokeStructured() {
        return { intent: "garbage" } as never;
      },
    };
    const r = await classifyIntent("隨便", bad, "count_events");
    expect(r.intent).toBe("count_events");
  });
});

describe("時間窗確定性解析（model 不碰日期）", () => {
  it("明天 → 隔日整日窗，label 含日期", () => {
    const w = resolveTimeWindow("明天有會議嗎", TZ, NOW)!;
    expect(w).not.toBeNull();
    expect(w.label).toContain("明天");
    expect(w.label).toContain("9/18");
    // 明天 00:00 Asia/Taipei = 前一日 16:00Z
    expect(w.from_utc).toBe("2026-09-17T16:00:00.000Z");
    expect(w.to_utc).toBe("2026-09-18T16:00:00.000Z");
  });

  it("今天 → 當日整日窗", () => {
    const w = resolveTimeWindow("今天有什麼事", TZ, NOW)!;
    expect(w.from_utc).toBe("2026-09-16T16:00:00.000Z");
    expect(w.to_utc).toBe("2026-09-17T16:00:00.000Z");
  });

  it("後天優先於明天（較長片語先比）", () => {
    const w = resolveTimeWindow("後天呢", TZ, NOW)!;
    expect(w.label).toContain("後天");
    expect(w.label).toContain("9/19");
  });

  it("這週 → 今天起到週日", () => {
    const w = resolveTimeWindow("這週我有幾個會", TZ, NOW)!;
    // 週四(9/17)起，到下週一 00:00（含週日整日）
    expect(w.from_utc).toBe("2026-09-16T16:00:00.000Z");
    expect(w.label).toBe("這週");
  });

  it("接下來 3 天", () => {
    const w = resolveTimeWindow("接下來 3 天有什麼", TZ, NOW)!;
    expect(w.label).toBe("接下來 3 天");
    expect(w.from_utc).toBe("2026-09-16T16:00:00.000Z");
    expect(w.to_utc).toBe("2026-09-19T16:00:00.000Z");
  });

  it("無時間詞 → null；defaultWindow 給 7 天", () => {
    expect(resolveTimeWindow("有會議嗎", TZ, NOW)).toBeNull();
    const d = defaultWindow(TZ, NOW);
    expect(d.label).toContain("7 天");
  });
});


describe("QuerySpec harness 清洗（對映真實 14B 髒輸出）", () => {
  const base: QuerySpec = {
    intent: "list", anchor: "none", weekday_from: null, weekday_to: null,
    daypart: "any", filter_keyword: null, group_name: null, order: "none",
  };
  const GROUPS = ["產品團隊", "Alpha 小隊"];

  it("null 正規化：\":null\"/\"none\"/\"\" → 真 null", () => {
    const s = normalizeSpec({ ...base, filter_keyword: ":null", group_name: "none" } as never);
    expect(s.filter_keyword).toBeNull();
    expect(s.group_name).toBeNull();
  });

  it("非法 enum → 安全降級", () => {
    const s = normalizeSpec({ intent: "garbage", anchor: "xxx", daypart: "zzz", order: "?" } as never);
    expect(s.intent).toBe("list");
    expect(s.anchor).toBe("none");
    expect(s.daypart).toBe("any");
  });

  it("daypart 原文覆核：問句沒說『下午』→ daypart 清成 any", () => {
    const s = reconcileSpec({ ...base, daypart: "afternoon" }, "跟客戶的會議有哪些", GROUPS);
    expect(s.daypart).toBe("any");
  });

  it("daypart 原文有『早上』→ 保留 morning", () => {
    const s = reconcileSpec({ ...base, daypart: "morning" }, "明天早上有空嗎", GROUPS);
    expect(s.daypart).toBe("morning");
  });

  it("daypart 雙向覆核：原文有『下午』但 model 漏填(any) → 補回 afternoon", () => {
    const s = reconcileSpec({ ...base, daypart: "any" }, "明天下午有沒有空", GROUPS);
    expect(s.daypart).toBe("afternoon");
  });

  it("單日 anchor 優先：明天 + 14B 亂填 weekday 全範圍 → 清掉 weekday", () => {
    const s = reconcileSpec({ ...base, anchor: "tomorrow", weekday_from: 0, weekday_to: 6 }, "我明天第一個會議幾點", GROUPS);
    expect(s.anchor).toBe("tomorrow");
    expect(s.weekday_from).toBeNull();
  });

  it("單一星期規則覆核：『這禮拜五』→ this_week + weekday 4", () => {
    const s = reconcileSpec({ ...base, anchor: "day_after_tomorrow" }, "這禮拜五有什麼會", GROUPS);
    expect(s.anchor).toBe("this_week");
    expect(s.weekday_from).toBe(4);
    expect(s.weekday_to).toBe(4);
  });

  it("『下禮拜三』→ next_week + weekday 2", () => {
    const s = reconcileSpec({ ...base }, "下禮拜三有會嗎", GROUPS);
    expect(s.anchor).toBe("next_week");
    expect(s.weekday_from).toBe(2);
  });

  it("group 覆核：14B 誤拆『產品團隊』→ 還原全名、清掉誤拆 keyword", () => {
    const s = reconcileSpec({ ...base, filter_keyword: "產品", group_name: "團隊" }, "這個月還有幾個跟產品團隊的會", GROUPS);
    expect(s.group_name).toBe("產品團隊");
  });

  it("group 核心詞覆核：『Alpha 那隊』+ 14B 殘詞 g=隊 → Alpha 小隊（不誤中含『隊』的產品團隊）", () => {
    const s = reconcileSpec({ ...base, filter_keyword: "Alpha", group_name: "隊" }, "Alpha 那隊都有誰", GROUPS);
    expect(s.group_name).toBe("Alpha 小隊");
  });

  it("group 殘詞不誤中：僅 g=隊、原文無任何群組核心詞 → 不強加群組", () => {
    const s = reconcileSpec({ ...base, group_name: "隊" }, "那一隊有什麼事", GROUPS);
    expect(s.group_name).toBeNull();
  });

  it("group 核心詞覆核：『產品那組』→ 對到 產品團隊", () => {
    const s = reconcileSpec({ ...base, group_name: "組" }, "產品那組現在誰在跑", GROUPS);
    expect(s.group_name).toBe("產品團隊");
  });

  it("範圍星期：『週三到週五』→ weekday_from=2, weekday_to=4（不丟範圍尾）", () => {
    const s = reconcileSpec({ ...base, anchor: "this_week", weekday_from: 2, weekday_to: 2 }, "我這週三到週五有什麼會", GROUPS);
    expect(s.weekday_from).toBe(2);
    expect(s.weekday_to).toBe(4);
  });

  it("範圍星期：省略第二個『週』——『週一到三』→ 0..2", () => {
    const s = reconcileSpec({ ...base }, "週一到三有哪些行程", GROUPS);
    expect(s.weekday_from).toBe(0);
    expect(s.weekday_to).toBe(2);
  });

  it("範圍星期：下週『下週二到週四』→ next_week + 1..3", () => {
    const s = reconcileSpec({ ...base }, "下週二到週四忙不忙", GROUPS);
    expect(s.anchor).toBe("next_week");
    expect(s.weekday_from).toBe(1);
    expect(s.weekday_to).toBe(3);
  });

  it("不存在的 group → 併入 keyword，不強加假群組", () => {
    const s = reconcileSpec({ ...base, group_name: "不存在小組" }, "不存在小組的會", GROUPS);
    expect(s.group_name).toBeNull();
    expect(s.filter_keyword).toBe("不存在小組");
  });

  it("泛詞 keyword（『會』）→ 清成 null（14B 常把泛詞塞進 filter）", () => {
    const s = reconcileSpec({ ...base, filter_keyword: "會" }, "明天有會議嗎", GROUPS);
    expect(s.filter_keyword).toBeNull();
  });

  it("整句被當成 keyword → 清成 null（否則會錯答「沒有行程」）", () => {
    const injected = "明天有哪些行程'; DROP TABLE events; --";
    const s = reconcileSpec({ ...base, filter_keyword: injected }, injected, GROUPS);
    expect(s.filter_keyword).toBeNull();
  });

  it("含問句用詞的 keyword（『有哪些』）→ 清成 null", () => {
    const s = reconcileSpec({ ...base, filter_keyword: "有哪些會" }, "明天有哪些會", GROUPS);
    expect(s.filter_keyword).toBeNull();
  });

  it("含引號/分號等注入樣式字元的 keyword → 清成 null", () => {
    const s = reconcileSpec({ ...base, filter_keyword: "客戶'; --" }, "找客戶'; -- 的會", GROUPS);
    expect(s.filter_keyword).toBeNull();
  });

  it("正常的長標題關鍵字仍保留（不過度清洗）", () => {
    const s = reconcileSpec(
      { ...base, filter_keyword: "產品週會" },
      "這個月還有幾個產品週會要開呢",
      GROUPS,
    );
    expect(s.filter_keyword).toBe("產品週會");
  });

  it("日期／時段詞被當 keyword → 清成 null（否則錯答「沒有行程」）", () => {
    for (const [kw, text] of [
      ["明天的安排", "不好意思想問一下我明天的安排"],
      ["明日", "明日の予定は？"],
      ["晚上", "今天晚上有安排嗎"],
      ["中午", "明天中午有空嗎"],
      ["這週的行程", "幫我看一下這週的行程"],
      ["最後一個行程", "明天最後一個行程是什麼"],
      ["最早的會", "明天最早的會是幾點"],
      ["第一個會議", "明天第一個會議是什麼"],
    ] as const) {
      const s = reconcileSpec({ ...base, filter_keyword: kw }, text, GROUPS);
      expect(s.filter_keyword, `kw=${kw}`).toBeNull();
    }
  });

  it("佔位符 keyword（『X』）→ 清成 null", () => {
    const s = reconcileSpec({ ...base, filter_keyword: "X" }, "這組由誰在跑", GROUPS);
    expect(s.filter_keyword).toBeNull();
  });

  it("原文未出現的幻想 keyword → 清成 null", () => {
    const s = reconcileSpec({ ...base, filter_keyword: "客戶" }, "明天有什麼會", GROUPS);
    expect(s.filter_keyword).toBeNull();
  });

  it("真實 keyword（原文出現的『客戶』）→ 保留", () => {
    const s = reconcileSpec({ ...base, filter_keyword: "客戶" }, "跟客戶的會有哪些", GROUPS);
    expect(s.filter_keyword).toBe("客戶");
  });

  it("誤判 group『行程』併入 keyword 後仍被雜訊過濾清掉", () => {
    const s = reconcileSpec({ ...base, group_name: "行程" }, "明天的行程", GROUPS);
    expect(s.group_name).toBeNull();
    expect(s.filter_keyword).toBeNull();
  });
});

describe("windowFromSpec 下週單一星期偏移", () => {
  const TZ2 = "Asia/Taipei";
  const NOW2 = new Date("2026-09-17T02:00:00Z"); // 週四

  it("下週週三 = 本週四 +5 天起（9/22 台北）", () => {
    const w = windowFromSpec("next_week", 2, 2, TZ2, NOW2);
    expect(w.label).toBe("下週週三");
    expect(w.from_utc).toBe("2026-09-22T16:00:00.000Z");
  });

  it("本週週五（9/18 台北）", () => {
    const w = windowFromSpec("this_week", 4, 4, TZ2, NOW2);
    expect(w.label).toBe("本週週五");
    expect(w.from_utc).toBe("2026-09-17T16:00:00.000Z");
  });
});

describe("時間錨點：上週 / 下個月（避免問 A 答 B）", () => {
  const TZ = "Asia/Taipei";
  const GROUPS = ["產品團隊", "Alpha 小隊"];
  const base: QuerySpec = normalizeSpec({ intent: "list" });
  const NOW = new Date("2026-09-18T02:00:00Z"); // 2026-09-18 10:00 台北（週五）

  it("上週 → 完整的上一個自然週，且整段落在現在之前", () => {
    const w = windowFromSpec("last_week", null, null, TZ, NOW);
    expect(w.label).toBe("上週");
    expect(+new Date(w.to_utc)).toBeLessThanOrEqual(+NOW);
    // 7 天
    expect((+new Date(w.to_utc) - +new Date(w.from_utc)) / 86_400_000).toBeCloseTo(7, 1);
  });

  it("下個月 → 整個下個月，且起點在現在之後", () => {
    const w = windowFromSpec("next_month", null, null, TZ, NOW);
    expect(w.label).toBe("下個月");
    expect(+new Date(w.from_utc)).toBeGreaterThan(+NOW);
    const days = (+new Date(w.to_utc) - +new Date(w.from_utc)) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);
  });

  it("這個月仍是「剩餘」語意（今天起算）", () => {
    const w = windowFromSpec("this_month", null, null, TZ, NOW);
    expect(w.label).toBe("這個月");
    expect(+new Date(w.from_utc)).toBeLessThanOrEqual(+NOW);
  });

  it("規則錨點：『上週』『下個月』字面可被解析（LLM 不可用時也對）", () => {
    expect(reconcileSpec({ ...base }, "上週有哪些會", GROUPS).anchor).toBe("last_week");
    expect(reconcileSpec({ ...base }, "下個月有什麼行程", GROUPS).anchor).toBe("next_month");
  });
});
