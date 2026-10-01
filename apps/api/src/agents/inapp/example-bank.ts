import type { RouteFamily } from "./semantic-harness.js";

/**
 * Query-conditioned ICL 的示例庫（訓練-free）。
 *
 * 依據 2026 的實證：對小模型而言，「依查詢語意檢索出的示例」穩定優於 zero-shot 與
 * 隨機 few-shot（query-conditioned ICL, arXiv:2607.18819），且 off-the-shelf embedding
 * 就足以做這種檢索（arXiv:2605.14145）；但示例數量與效果是非單調的，必須實測
 * （arXiv:2607.22969），因此數量由 INAPP_ICL_K 控制並以基準測量決定。
 *
 * 這裡放的是**示範**而不是關鍵字規則：比對靠語意向量，因此未見過的新措辭也能命中
 * 最接近的示範。刻意涵蓋容易互相混淆的對照組（數人 vs 數行程、有事 vs 有空、
 * 某場與會者 vs 團隊名單、同句多目的 vs 單一目的）。
 *
 * 維護原則：示例用「與驗證題不同的措辭」，避免把基準答案寫進提示而高估效果。
 */
export interface FamilyExample {
  text: string;
  family: RouteFamily;
  request_count: "one" | "multiple";
}

export const FAMILY_EXAMPLES: readonly FamilyExample[] = [
  // 既有行程（含細節、搜尋、邀請）
  { text: "禮拜五公司那邊排了什麼事", family: "agenda", request_count: "one" },
  { text: "後天早上是不是有事要處理", family: "agenda", request_count: "one" },
  { text: "下個週四還有沒有行程", family: "agenda", request_count: "one" },
  { text: "週報會議是在哪間房間舉行", family: "agenda", request_count: "one" },
  { text: "季度檢討會要開幾分鐘", family: "agenda", request_count: "one" },
  { text: "體檢預約是排在哪一天", family: "agenda", request_count: "one" },
  { text: "專案啟動會有哪些人出席", family: "agenda", request_count: "one" },
  { text: "誰寄的邀請還沒被我處理", family: "agenda", request_count: "one" },
  { text: "我等一下馬上要做的事情是什麼", family: "agenda", request_count: "one" },

  // 空檔（強調「沒有行程的時間」而非既有行程）
  { text: "禮拜五還挪得出一個鐘頭嗎", family: "availability", request_count: "one" },
  { text: "後天早上哪一段沒有被會議占住", family: "availability", request_count: "one" },
  { text: "我想找兩小時安靜做事，哪時候可以", family: "availability", request_count: "one" },

  // 團隊與人（包含「數人」）
  { text: "行銷部現在有幾個人", family: "people", request_count: "one" },
  { text: "這一組總共幾位同事", family: "people", request_count: "one" },
  { text: "客服小組的名單有誰", family: "people", request_count: "one" },
  { text: "我跟王經理最近會在哪個場合同時出現", family: "people", request_count: "one" },

  // 聚合統計（數的是行程）
  { text: "禮拜五總共有幾場會", family: "analytics", request_count: "one" },
  { text: "這個月我的會議量比上個月高嗎", family: "analytics", request_count: "one" },
  { text: "我平常最容易在哪一天被排滿", family: "analytics", request_count: "one" },

  // 修改日曆
  { text: "把季度檢討會挪到禮拜五下午", family: "mutation", request_count: "one" },
  { text: "體檢預約我不去了，幫我刪掉", family: "mutation", request_count: "one" },
  { text: "王經理那個邀請幫我按同意", family: "mutation", request_count: "one" },
  { text: "禮拜五幫我安排一場專案同步", family: "mutation", request_count: "one" },

  // 非日曆
  { text: "幫我把季度檢討的開場稿潤飾一下", family: "out_of_scope", request_count: "one" },
  { text: "推薦公司附近好吃的午餐", family: "out_of_scope", request_count: "one" },

  // v1 回歸發現的易混淆形狀（措辭刻意與評測題不同）
  { text: "禮拜五傍晚之後還有沒有排事情", family: "agenda", request_count: "one" },
  { text: "今天入夜以後還有要出席的事嗎", family: "agenda", request_count: "one" },
  { text: "我跟王經理下次何時一起開會", family: "people", request_count: "one" },
  { text: "我和客服主管接下來哪一場會同時出席", family: "people", request_count: "one" },
  { text: "替下週報告寫一段結語，不需要讀取日曆", family: "out_of_scope", request_count: "one" },
  { text: "幫我擬一句專案簡報標題，不必存取行事曆", family: "out_of_scope", request_count: "one" },

  { text: "下週會不會比較輕鬆", family: "analytics", request_count: "one" },
  { text: "這個月是不是比上個月忙", family: "analytics", request_count: "one" },
  { text: "客服小組成員名單", family: "people", request_count: "one" },
  { text: "行銷部名單給我", family: "people", request_count: "one" },

  // 同句多目的（含同日不同時段各自整理）
  { text: "禮拜五的行程給我，另外也幫我找一小時空檔", family: "agenda", request_count: "multiple" },
  { text: "早上跟晚上的事情請分開整理給我", family: "agenda", request_count: "multiple" },
  { text: "先講季度檢討會的房間，再給我客服小組名單", family: "agenda", request_count: "multiple" },
  { text: "後天有什麼事，還有哪些邀請在等我", family: "agenda", request_count: "multiple" },
  { text: "這個月的會議量，以及行銷部人數各告訴我", family: "analytics", request_count: "multiple" },
];
