/**
 * 本地能力自評與升級決策（local-first cascade across agents）。
 *
 * 問題背景（實測發現）：
 * 先前的協作只有兩種極端——`plan` 讓外部 agent 做完全部理解（本地 14B 一次都沒被呼叫，
 * GPU 全程閒置，本地退化成帶 RLS 的資料庫）；`question` 讓本地做完全部理解（外部只是轉傳）。
 * 兩者都不是協作：沒有任何一種模式讓兩邊各出所長。
 *
 * 方法依據：
 *  - SWARM-LLM（IEEE VTC2026-Spring, Dahshan et al., 程式碼 github.com/mdahshan/swarm_llm）：
 *    以「輕量難度估計 + 安全訊號」做三層門檻決策（本地／同儕／召喚雲端）。
 *    其實測：edge-only 在困難題正確率 0.00，加入選擇性升級後 0.15（cloud-only 0.30），
 *    同時把雲端曝露率降低 72%、token 曝露率降低 58.7%。
 *  - Hybrid LLM（Ding et al., ICLR 2024）與 FrugalGPT（Chen et al., TMLR 2024）：
 *    以成本／品質感知的路由決定何時叫更貴的模型。
 *  - 反面證據：小模型的自我評估不可靠（arXiv:2504.04718；EMNLP 2025「Too Consistent to Detect」）。
 *    因此這裡**不使用 14B 自評信心**，而用兩類可驗證的確定性訊號：
 *      (1) 能力邊界：問題需要的運算，本地工具面根本沒有實作（例如「最長空檔」「總共幾小時」「哪些重疊」）
 *      (2) 執行過程的推測：候選重排、語法補抽等步驟被標記為 uncertain
 *
 * 關鍵區別：(1) 是**能力缺口**，不是信心問題——本地再有信心也算不出總時數，
 * 因此這類問題不必先跑一次模型才發現做不到，直接備好事實交給外部 agent 推理。
 */

/**
 * 需要「對取得的資料再做運算」的運算子類別。
 * 這是封閉的運算子詞類（極值、聚合、比較、衝突偵測、排序），不含任何日曆領域詞彙，
 * 因此對沒見過的說法同樣有效。
 */
const OPERATOR_CLASSES: Array<{ id: string; pattern: RegExp; needs: string }> = [
  {
    id: "extremum_over_derived",
    // 「最長的空檔」「最短的間隔」——極值必須先算出衍生量（空檔長度）才能比較
    pattern: /最[長长短久]|最大的?(?:空|間隔)|最小的?(?:空|間隔)/,
    needs: "先算出每段衍生量（如空檔長度）再取極值",
  },
  {
    id: "aggregation",
    // 「總共幾小時」「加起來多久」「平均」——需要跨多筆求和／平均
    pattern: /總共.{0,4}(?:幾|多少).{0,2}(?:小時|分鐘|鐘頭)|加起來|總時數|總時長|合計|平均.{0,4}(?:幾|多少|多長)|幾個小時的?會/,
    needs: "跨多筆行程求和或平均",
  },
  {
    id: "conflict_detection",
    // 「哪些重疊」「有沒有撞期」——需要兩兩比對時間區間
    pattern: /重[疊叠]|撞[期到時时]|衝突|沖突|卡在一起|同時(?:段)?.{0,3}兩/,
    needs: "同一天內的行程兩兩比對起訖時間",
  },
  {
    id: "comparison_of_derived",
    // 「上午還是下午比較忙」——需要先分組統計再比較
    pattern: /(?:上午|早上).{0,6}(?:還是|或).{0,6}(?:下午|晚上)|(?:下午).{0,6}(?:還是|或).{0,6}(?:晚上|上午)|哪一?[天邊边個个].{0,4}比較|比較忙的?是/,
    needs: "先分組統計再比較",
  },
  {
    id: "cross_entity_enumeration",
    // 「兩場X分別在哪」「三場會分別跟誰」——需要對多個同類實體逐一取細節
    pattern: /[兩两三四五六]\s*[場场個个筆笔].{0,8}分別|分別在哪|分別跟|各自在哪|各在哪/,
    needs: "對多個實體逐一取細節再併列",
  },
  {
    id: "dependent_lookup",
    // 「牙醫預約那天還有其他行程嗎」——必須先查出該事件是哪一天，才能查那天的全部行程。
    // 本地是單次查詢，沒有把前一次結果當成下一次條件的能力（實測本地只回了牙醫預約本身）。
    pattern: /[\u4e00-\u9fa5A-Za-z0-9]{2,12}\s*(?:那|這|當)\s*[天日]|[\u4e00-\u9fa5A-Za-z0-9]{2,12}\s*(?:之後|之前)\s*(?:的|還)/,
    needs: "先解析出指定事件的日期，再以該日期查詢（兩段相依查詢）",
  },
  {
    id: "unbounded_enumeration",
    // 「哪幾場會在大會議室開的」——沒有任何時間詞，本地會套預設 7 天窗而靜默截斷
    //（實測漏掉第 9 天的產品路線圖對焦）。人物類問題有專屬工具，不在此列。
    pattern: /哪幾[場场個个]|哪些.{0,4}(?:會議|會|行程)/,
    needs: "跨越預設時間窗的完整列舉（本地預設只看 7 天，會靜默截斷）",
  },
  {
    id: "derived_interval",
    // 「排練前我有多少時間」——需要算某事件與前一事件之間的間隔
    pattern: /(?:前|之前|以前).{0,6}(?:有多少|剩多少|還有多少).{0,4}時間|多少時間可以(?:準備|處理)|空出多少/,
    needs: "計算指定事件與相鄰事件之間的間隔",
  },
];

export interface CompetenceAssessment {
  /** 本地是否具備回答此問題所需的運算能力 */
  competent: boolean;
  /** 觸發升級的運算子類別 */
  operators: Array<{ id: string; needs: string }>;
  /** 給呼叫端看的說明 */
  reason: string;
}

/**
 * 確定性能力自評：只看「問題需要哪種運算」，不呼叫任何模型。
 * 偵測到本地工具面沒有實作的運算 → 不具備能力，應由呼叫端接手推理。
 */
/** 時間表達：有明確時間範圍時，本地的時間窗就不是任意截斷。 */
const TIME_EXPRESSION =
  /今天|明天|後天|昨天|今日|明日|這週|本週|下週|上週|這個月|本月|下個月|月底|週末|接下來|最近|未來|星期[一二三四五六日天]|週[一二三四五六日天]|禮拜[一二三四五六日天]|\d{4}-\d{2}-\d{2}/;
/**
 * 有專屬本地工具的查詢類別，不必升級（實測本地在這些題上表現正常）：
 * 人物共同行程（events_with_person）、團隊成員（list_members）、待回覆邀請（list_pending）。
 */
const HAS_DEDICATED_LOCAL_TOOL =
  /共同|跟.{1,5}(?:的|一起|開)|和.{1,5}(?:的|一起|開)|哪些人|有誰|成員|名單|待回覆|待處理|等我回覆|還沒回|沒回覆|邀請/;

export function assessLocalCompetence(text: string): CompetenceAssessment {
  const hits = OPERATOR_CLASSES.filter((c) => {
    if (!c.pattern.test(text)) return false;
    // 無界列舉只在「沒有時間詞且不是人物類」時才算能力缺口
    if (c.id === "unbounded_enumeration") {
      return !TIME_EXPRESSION.test(text) && !HAS_DEDICATED_LOCAL_TOOL.test(text);
    }
    return true;
  });
  if (hits.length === 0) {
    return { competent: true, operators: [], reason: "問題可由既有查詢工具直接回答" };
  }
  return {
    competent: false,
    operators: hits.map((h) => ({ id: h.id, needs: h.needs })),
    reason:
      `此問題需要對查詢結果再做運算（${hits.map((h) => h.needs).join("、")}），` +
      "本地查詢工具面沒有這類運算；已附上所需事實，請由呼叫端完成推理。",
  };
}

/** 供 server card 宣告：本地會主動升級的運算子類別。 */
export function escalationOperatorCatalogue(): Array<{ id: string; needs: string }> {
  return OPERATOR_CLASSES.map((c) => ({ id: c.id, needs: c.needs }));
}
