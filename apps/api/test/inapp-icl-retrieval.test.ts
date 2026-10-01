import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAMILY_EXAMPLES } from "../src/agents/inapp/example-bank.js";
import {
  formatFamilyExamples,
  resetIclCache,
  retrieveFamilyExamples,
} from "../src/agents/inapp/icl-retrieval.js";

/**
 * Query-conditioned ICL（訓練-free）單元測：
 *  - 檢索必須依語意挑到正確對照組（數人 vs 數行程）。
 *  - 同一 family 最多 2 筆，確保提示帶到對照而非同類重複。
 *  - embedding 服務不可用時必須 fail-open 回 zero-shot，不可讓路由失敗。
 */

const ORIGINAL_BASE = process.env.LLM_BASE_URL;

/** 以「字元交集」當假 embedding：足以驗證檢索與 MMR 邏輯，不需真模型。 */
function fakeEmbedding(text: string): number[] {
  const vocab = "行程會議人幾個空檔團隊成員分別另外刪掉挪到同意午餐稿房間分鐘哪天出席邀請";
  return [...vocab].map((ch) => (text.includes(ch) ? 1 : 0));
}

function mockEmbedServer() {
  process.env.LLM_BASE_URL = "http://embed.test/v1";
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { input: string[] };
    return new Response(
      JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: fakeEmbedding(text) })) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return spy;
}

beforeEach(() => {
  resetIclCache();
  vi.restoreAllMocks();
  if (ORIGINAL_BASE === undefined) delete process.env.LLM_BASE_URL;
  else process.env.LLM_BASE_URL = ORIGINAL_BASE;
});

describe("query-conditioned ICL 檢索", () => {
  it("『數人』的問法會檢索到 team_or_person 對照，而不是只給行程類示例", async () => {
    mockEmbedServer();
    const picked = await retrieveFamilyExamples("這個小隊裡有幾個人", 4);
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.some((e) => e.family === "people")).toBe(true);
  });

  it("同一 family 最多 2 筆，提示中保留對照組", async () => {
    mockEmbedServer();
    const picked = await retrieveFamilyExamples("明天有幾個會", 6);
    const counts = new Map<string, number>();
    for (const e of picked) counts.set(e.family, (counts.get(e.family) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBeLessThanOrEqual(2);
  });

  it("k<=0 視為關閉，不呼叫 embedding 服務", async () => {
    const spy = mockEmbedServer();
    const picked = await retrieveFamilyExamples("明天有什麼", 0);
    expect(picked).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("embedding 服務失敗 → fail-open 回 zero-shot", async () => {
    process.env.LLM_BASE_URL = "http://embed.test/v1";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const picked = await retrieveFamilyExamples("明天有什麼", 4);
    expect(picked).toEqual([]);
    expect(formatFamilyExamples(picked)).toBe("");
  });

  it("未設定 LLM_BASE_URL 時安全跳過檢索", async () => {
    delete process.env.LLM_BASE_URL;
    const picked = await retrieveFamilyExamples("明天有什麼", 4);
    expect(picked).toEqual([]);
  });

  it("示範格式化成模型可讀的標籤，且包含 request_count", () => {
    const text = formatFamilyExamples([
      { text: "行銷部現在有幾個人", family: "people", request_count: "one" },
      { text: "早上跟晚上的事情請分開整理給我", family: "agenda", request_count: "multiple" },
    ]);
    expect(text).toContain("family=team_or_person");
    expect(text).toContain("request_count=multiple");
  });

  it("示例庫涵蓋全部 6 個能力家族與多目的樣本", () => {
    const families = new Set(FAMILY_EXAMPLES.map((e) => e.family));
    expect(families.size).toBe(6);
    expect(FAMILY_EXAMPLES.some((e) => e.request_count === "multiple")).toBe(true);
  });
});
