import { describe, expect, it } from "vitest";
import { assessLocalCompetence } from "../src/mcp/collaboration.js";

/**
 * 升級決策的價值在於「本地做不到的就不要硬做」，風險在於「該自己答的卻推給外部」。
 * 兩邊都要釘死：偵測到需要再運算的問題才升級，單純查詢一律本地處理。
 */
describe("本地能力自評（確定性，不呼叫模型）", () => {
  it("需要對結果再運算的問題 → 升級", () => {
    const cases: Array<[string, string]> = [
      ["明天哪一段空檔最長？", "extremum_over_derived"],
      ["明天總共要開幾個小時的會？", "aggregation"],
      ["我有哪些行程時間互相重疊？", "conflict_detection"],
      ["我明天最忙的是上午還是下午？", "comparison_of_derived"],
      ["兩場專案同步會分別在哪個會議室？", "cross_entity_enumeration"],
      ["客戶簡報排練那天，排練前我有多少時間可以準備？", "derived_interval"],
      // 以下兩類是由協作實測補上的：本地自評曾誤判為「有能力」但答錯
      ["牙醫預約那天我還有其他行程嗎？", "dependent_lookup"],
      ["哪幾場會是在大會議室開的？", "unbounded_enumeration"],
    ];
    for (const [text, operator] of cases) {
      const a = assessLocalCompetence(text);
      expect(a.competent, text).toBe(false);
      expect(a.operators.map((o) => o.id), text).toContain(operator);
    }
  });

  it("單純查詢／細節／成員名單一律本地處理，不可濫用升級", () => {
    for (const text of [
      "明天有哪些行程？",
      // 有時間詞 → 時間窗不是任意截斷；人物類 → 有專屬工具
      "明天有哪些會議？",
      "明天有幾場會？",
      "產品週會在哪裡？",
      "工程團隊有哪些人？",
      "明天下午有沒有空檔？",
      "別人發起、還在等我回覆的會議有哪幾場？",
      "我跟王大文有哪些共同會議？",
    ]) {
      expect(assessLocalCompetence(text).competent, text).toBe(true);
    }
  });
});
