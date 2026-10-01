/**
 * 子句切分（clause factorization）。
 *
 * 依據：Clause-Factorized Decoding for Compositional Multi-Intent Detection
 * （arXiv:2603.28929，2026）與 SPM（Jiang et al., ACL 2023 Industry）皆指出——
 * 「整句多標籤 + 連接詞統計」在連接詞或包裝語改變時會崩潰（該論文 manual set 上
 * 整句法在 connector shift 僅 10.4 EM，子句分解法 86.7），而把句子切成子句、
 * 對每個子句各自分類，能在未見過的組合上維持表現。
 *
 * 因此本模組**只負責產生候選子句**（recall），最終是否真的是多個需求由模型的
 * Planner 逐子句判斷（precision）。論文自己也指出啟發式切分是弱點（oracle 切分可達
 * 100%），所以這裡刻意保守：切完若只剩一個「有內容」的子句，就當單一需求。
 */

/** 並列／承接類話語標記：只當作候選邊界，不直接當成多需求的結論。 */
const COORDINATION_MARKERS = /另外|然後|接著|還有|以及|並且|順便|同時|再幫|再查|再看|再找|再列|再說|再給/g;

/** 純寒暄／語氣的子句不算需求（等同 IR 的 stopword 處理）。 */
const POLITENESS_ONLY = /^(?:不好意思|抱歉|麻煩你?|請問|謝謝|感謝|打擾了?|不好意思打擾|你好|嗨|哈囉|拜託|勞煩|辛苦了?|嗯+|喔+|啊+|對了|順帶一提)[，。！？!?…、\s]*$/;

/** 分配型運算子：語法上明確要求「各自給一份答案」，即使只有一個子句。 */
const DISTRIBUTIVE_MARKERS = /分別|各自|各別|分開|拆開|拆成|拆兩|分兩段|分三段|分兩份|分三份|各一份|各列|各給|各有|各是|各[幾几]|一個一個/;

function isContentClause(segment: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length < 3) return false;
  if (POLITENESS_ONLY.test(trimmed)) return false;
  return true;
}

/**
 * 切出候選子句。先以標點切，再以並列標記切；回傳「有內容」的子句。
 * 單一需求時長度為 1。
 */
export function clauseSegments(text: string): string[] {
  const byPunctuation = text
    .split(/[，,；;。！!？?\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const segments: string[] = [];
  for (const part of byPunctuation) {
    const pieces = part
      .replace(COORDINATION_MARKERS, (m) => `\u0000${m}`)
      .split("\u0000")
      .map((s) => s.trim())
      .filter(Boolean);
    segments.push(...pieces);
  }
  const content = segments.filter(isContentClause);
  return content.length ? content : [text.trim()].filter(Boolean);
}

/**
 * 是否值得叫 Planner 逐子句分解。
 * 兩種情況：切出多個有內容子句，或出現分配型運算子（「上午和下午分別列出」）。
 */
export function looksCompositional(text: string): boolean {
  if (DISTRIBUTIVE_MARKERS.test(text)) return true;
  return clauseSegments(text).length >= 2;
}
