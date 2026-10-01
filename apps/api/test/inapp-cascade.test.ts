import { describe, expect, it } from "vitest";
import { deterministicallyCovered, fastPathIntent } from "../src/agents/inapp/cascade.js";

const GROUPS = ["Alpha 小隊", "產品團隊", "工程團隊", "設計團隊", "客戶成功小組"];

/**
 * tier-0 的價值在於「敢跳過模型」，風險在於「跳錯」。
 * 因此這裡兩邊都要釘死：該開的要開（省 2 次呼叫約 4.8s），
 * 只要句中還有實體／指代／多需求／寫入意圖就必須 defer。
 */
describe("cascade tier-0：確定性覆蓋才跳過模型", () => {
  it("純時間＋日曆泛稱的查詢可直接走確定性路徑", () => {
    expect(fastPathIntent("明天有哪些行程？", GROUPS)).toBe("list_events");
    expect(fastPathIntent("今天有什麼會？", GROUPS)).toBe("list_events");
    expect(fastPathIntent("明天下午有什麼安排？", GROUPS)).toBe("list_events");
    expect(fastPathIntent("後天上午的行程列一下。", GROUPS)).toBe("list_events");
    expect(fastPathIntent("明天有幾場會？", GROUPS)).toBe("count_events");
    expect(fastPathIntent("明天下午有沒有空檔？", GROUPS)).toBe("find_free");
    expect(fastPathIntent("下週一有空嗎？", GROUPS)).toBe("find_free");
  });

  it("句中出現實體（標題／人名／地點／非日曆主題）一律 defer", () => {
    expect(fastPathIntent("產品週會在哪裡？", GROUPS)).toBeNull();
    expect(fastPathIntent("我跟林小明有哪些共同會議？", GROUPS)).toBeNull();
    expect(fastPathIntent("大會議室被用在哪幾場會？", GROUPS)).toBeNull();
    expect(fastPathIntent("今天天氣如何？", GROUPS)).toBeNull();
    expect(fastPathIntent("幫我訂一張去東京的機票。", GROUPS)).toBeNull();
  });

  it("多需求、指代、寫入與非日曆宣告一律 defer", () => {
    expect(fastPathIntent("明天的行程列一下，另外幫我找一小時空檔。", GROUPS)).toBeNull();
    expect(fastPathIntent("那場會幾點開始？", GROUPS)).toBeNull();
    expect(fastPathIntent("把明天的會取消。", GROUPS)).toBeNull();
    expect(fastPathIntent("不用查日曆，直接告訴我明天有什麼", GROUPS)).toBeNull();
  });

  it("團隊名稱視為已解釋，但成員名單類意圖仍 defer", () => {
    expect(deterministicallyCovered("工程團隊明天有什麼會？", GROUPS)).toBe(true);
    // list_members 不在 tier-0 白名單（需解析群組與權限）
    expect(fastPathIntent("工程團隊有哪些人？", GROUPS)).toBeNull();
  });

  it("兩個訊號不一致時 defer（舊規則把『有哪些時段是空的』誤歸 list）", () => {
    expect(fastPathIntent("明天有哪些時段是空的？", GROUPS)).toBeNull();
    // 兩訊號一致時（這句確實是找空檔）仍應放行，避免過度保守
    expect(fastPathIntent("明天有沒有空檔？", GROUPS)).toBe("find_free");
  });

  it("純時間省略句視為查詢那段時間的行程", () => {
    expect(fastPathIntent("明天傍晚以後呢？", GROUPS)).toBe("list_events");
    expect(fastPathIntent("後天呢？", GROUPS)).toBe("list_events");
    // 沒有時間表達又沒有標記 → 不可亂猜
    expect(fastPathIntent("那呢？", GROUPS)).toBeNull();
  });

  it("排序／序數問法一律 defer（舊規則會丟掉 next_event 這個更細的意圖）", () => {
    expect(fastPathIntent("我下一個行程是什麼？", GROUPS)).toBeNull();
    expect(fastPathIntent("明天第一場會是什麼？", GROUPS)).toBeNull();
    expect(fastPathIntent("明天最晚的是哪一場？", GROUPS)).toBeNull();
  });

  it("覆蓋檢查對未知詞彙保持保守", () => {
    expect(deterministicallyCovered("明天有哪些行程", GROUPS)).toBe(true);
    expect(deterministicallyCovered("明天的季度預算檢討在哪", GROUPS)).toBe(false);
    expect(deterministicallyCovered("接下來三天有哪些會議", GROUPS)).toBe(true);
  });
});
