import { describe, it, expect, beforeEach } from "vitest";
import { polishReply } from "../src/agents/inapp/reply-polish.js";
import { getCachedRoute, setCachedRoute, clearRouteCache, normalizeKey } from "../src/agents/inapp/route-cache.js";
import type { ChatModel } from "../src/agents/llm.js";
import type { RouteResult } from "../src/agents/inapp/router.js";

/**
 * 優化 A（潤飾護欄）與 D（route 快取）單元測（純函式）。
 * A 的核心保證：潤飾絕不因幻覺/漏事實/竄改數字而答錯——任一護欄不過即回退模板。
 */

/** 產一個回固定 reply 的 stub model。 */
function polishStub(reply: string): ChatModel {
  return {
    async invokeStructured() {
      return { reply } as never;
    },
  };
}
const throwing: ChatModel = { async invokeStructured() { throw new Error("down"); } };

describe("回覆潤飾護欄（A）", () => {
  const OLD = process.env.INAPP_POLISH;
  beforeEach(() => { process.env.INAPP_POLISH = "1"; });
  // 還原
  const restore = () => { if (OLD === undefined) delete process.env.INAPP_POLISH; else process.env.INAPP_POLISH = OLD; };

  it("預設關（INAPP_POLISH 未設）→ 原樣回模板，不打 model", async () => {
    delete process.env.INAPP_POLISH;
    let called = false;
    const spy: ChatModel = { async invokeStructured() { called = true; return { reply: "x" } as never; } };
    const out = await polishReply("今天沒有會議。", [], spy);
    expect(out).toBe("今天沒有會議。");
    expect(called).toBe(false);
    restore();
  });

  it("潤飾保留全部事實 → 採用潤飾", async () => {
    const tmpl = "明天（9/18）有 1 個會議：9/18 14:00 產品週會";
    const facts = ["9/18", "14:00", "產品週會", "1"];
    const out = await polishReply(tmpl, facts, polishStub("明天（9/18）有 1 個安排，9/18 14:00 的產品週會。"));
    expect(out).toContain("9/18");
    expect(out).toContain("產品週會");
    expect(out).not.toBe(tmpl); // 確實被改寫
    restore();
  });

  it("潤飾漏掉事實（少了標題）→ 回退模板", async () => {
    const tmpl = "明天有 產品週會";
    const out = await polishReply(tmpl, ["產品週會"], polishStub("明天有個會。"));
    expect(out).toBe(tmpl);
    restore();
  });

  it("潤飾竄改/新增數字 → 回退模板（防幻覺）", async () => {
    const tmpl = "今天有 1 個會議。";
    const out = await polishReply(tmpl, ["1"], polishStub("今天有 1 個會議，下午 3 點開始。"));
    expect(out).toBe(tmpl); // 「3」是原文沒有的數字 → 回退
    restore();
  });

  it("潤飾疊字（重複同一日期）→ 回退模板", async () => {
    const tmpl = "今天（9/17）沒有會議。";
    const out = await polishReply(tmpl, ["9/17"], polishStub("今天（9/17）今天（9/17）沒有會議。"));
    expect(out).toBe(tmpl);
    restore();
  });

  it("潤飾夾帶開場白『好的，』→ 自動剝除後仍採用", async () => {
    const tmpl = "今天沒有會議。";
    const out = await polishReply(tmpl, [], polishStub("好的，今天沒有任何會議喔。"));
    expect(out.startsWith("好的")).toBe(false);
    expect(out).toContain("今天沒有");
    restore();
  });

  it("LLM 例外 → 回退模板（絕不卡死）", async () => {
    const out = await polishReply("今天沒有會議。", [], throwing);
    expect(out).toBe("今天沒有會議。");
    restore();
  });

  it("暴長輸出 → 回退模板（防夾帶大段杜撰）", async () => {
    const tmpl = "今天沒有會議。";
    const out = await polishReply(tmpl, [], polishStub("今天沒有會議。".repeat(30)));
    expect(out).toBe(tmpl);
    restore();
  });
});

describe("route 快取（D）", () => {
  beforeEach(() => clearRouteCache());
  const mk = (via: RouteResult["via"]): RouteResult => ({
    intent: "list_events",
    spec: { intent: "list", anchor: "tomorrow", weekday_from: null, weekday_to: null, daypart: "any", filter_keyword: null, group_name: null, order: "none" },
    via,
  });

  it("存後可取（agent 結果）", () => {
    setCachedRoute("明天有什麼", mk("agent"));
    expect(getCachedRoute("明天有什麼")?.via).toBe("agent");
  });

  it("正規化 key：大小寫/空白差異視為同一句", () => {
    setCachedRoute("Tomorrow  Free?", mk("agent"));
    expect(getCachedRoute("tomorrow free?")).not.toBeNull();
    expect(normalizeKey("  A  B ")).toBe("a b");
  });

  it("不快取 rules-fallback（降級不黏住）", () => {
    setCachedRoute("嗯", mk("rules-fallback"));
    expect(getCachedRoute("嗯")).toBeNull();
  });

  it("clear 後全空", () => {
    setCachedRoute("x", mk("agent"));
    clearRouteCache();
    expect(getCachedRoute("x")).toBeNull();
  });
});
