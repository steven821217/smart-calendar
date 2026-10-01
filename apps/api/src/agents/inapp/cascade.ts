/**
 * Cascade tier-0：完全不呼叫 14B 就能安全回答的「容易輸入」。
 *
 * 方法依據：ICLR 2025《Faster Cascades via Speculative Decoding》(Narasimhan et al.)
 * 指出 cascade 的關鍵是 **deferral rule**——只有「困難輸入」才升級到昂貴模型；
 * 論文同時強調品質中立（quality-neutrality）是必要條件，不可為了省成本而降品質。
 * ICLR 2026《Routing, Cascades, and User Choice for LLMs》亦以任務難度決定路由。
 *
 * 本專案的硬限制：qwen3:14b 在這張 GPU 上生成速度約 30 tok/s（實測，非降頻），
 * 因此每次結構化輸出約 70 tokens ≈ 2.4s。延遲只能靠「少呼叫、少生成」降低。
 *
 * 我們的 deferral rule 不是信心分數（小模型自評不可靠，見 arXiv:2504.04718），
 * 而是**確定性覆蓋檢查**：把整句依封閉語法類別（時間詞、時段、排序、時長、量詞、
 * 日曆泛稱、已知團隊名、疑問與禮貌虛詞）逐一剝除，若沒有任何殘留字元，
 * 表示這句話不含任何實體／主題／跨人指涉，確定性解析已覆蓋全句語意 → 可直接回答。
 * 只要殘留任何一個實義字，就 defer 給 14B（寧可慢，不可錯）。
 */
import { classifyByRules } from "./intent.js";
import { looksCompositional } from "./clause-split.js";
import { discourseSignals, explicitlyDeclinesCalendarLookup } from "./semantic-harness.js";
import { CALENDAR_GENERIC_NOUNS, durationMinutesFromText, ORDINAL_WORDS, TIME_WORDS } from "./query-spec.js";
import type { Intent } from "./intent.js";

/**
 * 獨立於 classifyByRules 的意圖標記類別。
 *
 * 需要第二個訊號的原因：classifyByRules 的 list_events 是廣泛兜底分支，
 * 實測「明天有哪些時段是空的」會因為「有哪些」被歸成 list_events（正解是 find_free）。
 * 覆蓋檢查只驗「槽位是否解析完整」，驗不出「意圖是否正確」。
 *
 * 做法依據：agreement-based deferral（arXiv:2509.21837, Semantic Agreement Enables
 * Efficient Open-Ended LLM Cascades）——用兩個便宜訊號是否一致當作升級判準。
 * 兩個訊號不一致 → 這句話對規則層而言就是「困難輸入」→ defer 給 14B。
 */
const FREE_MARKERS = /有空|沒空|空檔|空閒|空档|空的|空下來|檔期|時段|不用開會|不必開會/;
const COUNT_MARKERS = /[幾几][場场個个次件筆笔]|多少|忙不忙|忙嗎|滿不滿|滿嗎/;
const LIST_MARKERS = /有什麼|有甚麼|有哪些|有沒有什麼|列一下|列出|行程|安排|會議|要開的?會/;

/** 標記型意圖：優先序反映語意強度（空檔 > 數量 > 列表）。無標記回 null。 */
function markerIntent(text: string): Intent | null {
  if (FREE_MARKERS.test(text)) return "find_free";
  if (COUNT_MARKERS.test(text)) return "count_events";
  if (LIST_MARKERS.test(text)) return "list_events";
  return null;
}

/** tier-0 只承接這些唯讀意圖；寫入、跨人、成員名單等一律 defer。 */
const FAST_PATH_INTENTS = new Set<Intent>(["list_events", "count_events", "find_free"]);

/**
 * 完整的星期表達：必須在 TIME_WORDS 之前剝除。
 * TIME_WORDS 的交替順序會先吃掉「下週」而留下孤立的「一」，看起來像未解釋實體。
 */
const WEEKDAY_PHRASE = /(?:這|本|下|上|next|last)?\s*(?:週|周|星期|禮拜)\s*[一二三四五六七日天]/g;

/** 數字化的時間／期間表達（三點半、10:30、兩天、一週、45 分鐘、一個半小時…）。 */
const NUMERIC_TIME =
  /[0-9０-９一二三四五六七八九十兩两半幾]+\s*(?:點半|點|:\d{2}|分鐘|分|小時|鐘頭|天|日|週|周|星期|禮拜|個月|月)/g;

/** 時長／範圍修飾語。 */
const DURATION_WORDS = /半天|整天|全天|一整天|連續|左右|大概|大約|約|起碼|至少|以上|以內|以下/g;

/**
 * 疑問、禮貌、指涉自己、以及查詢動作的虛詞。
 * 這是**封閉的功能詞類**，不含任何日曆領域詞彙，也不含任何實體名稱：
 * 凡是剝不掉的字元都可能是實體（標題／人名／地點／非日曆主題）→ defer。
 */
const FUNCTION_WORDS =
  /請|麻煩|幫我|幫忙|可以|能不能|能|要不要|要|想|我的|我|你|您|一下|看看|看|列出來|列出|列|給我|告訴我|查查|查|問|知道|還有沒有|還有|還|有沒有|有哪些|有什麼|有些|有|沒有|沒|哪些|哪個|哪一?[天個場件筆次]|哪|什麼|甚麼|怎樣|如何|怎麼|多少|幾|嗎|呢|吧|嘛|啊|喔|哦|耶|欸|的|了|著|過|是不是|是否|是|在|於|到|至|從|跟|和|與|及|也|都|只|就|共|總共|一共|另外|順便|裡面|裡|內|中|前|後|之前|之後|以前|以後|剩下|目前|現在|目前為止|安排|排定|出席|參加|處理|開|要開|被|佔用|滿|忙|空檔|空閒|空档|檔期|空|空的|不用|免|需要|需|得|會不會|會|事項|狀況|情況|時段|時間|期間|區間|範圍|清單|名單|概況|狀態/g;

/**
 * 量詞：封閉類別。「幾場」「兩個」「一筆」中的量詞本身不帶語意實體。
 * 刻意不含「人／位」——成員名單類意圖不在 tier-0 白名單，避免誤跳。
 */
const MEASURE_WORDS = /[場场個个次件筆笔堂節节份通則则項项]/g;

/** 標點與空白。 */
const PUNCTUATION = /[\s，。、！？；：,.!?;:~～…「」『』（）()【】\[\]"'`·—\-_/]/g;

/**
 * deferral rule：確定性解析是否已覆蓋整句語意。
 * @param groups 本 workspace 既有團隊名稱（出現在句中時視為已解釋）。
 */
export function deterministicallyCovered(text: string, groups: string[] = []): boolean {
  let residue = text;
  // 先剝團隊名（含去泛型後綴的核心詞），避免團隊名被當成未解釋實體。
  for (const g of groups) {
    if (!g) continue;
    residue = residue.split(g).join("");
    const core = g.replace(/團隊|小隊|小組|群組|團|隊|組|群|\s+/g, "");
    if (core.length >= 2) residue = residue.split(core).join("");
  }
  residue = residue
    .replace(WEEKDAY_PHRASE, "")
    .replace(TIME_WORDS, "")
    .replace(ORDINAL_WORDS, "")
    .replace(NUMERIC_TIME, "")
    .replace(DURATION_WORDS, "")
    .replace(CALENDAR_GENERIC_NOUNS, "")
    .replace(MEASURE_WORDS, "")
    .replace(FUNCTION_WORDS, "")
    .replace(PUNCTUATION, "");
  // 殘留任何中日韓文字、字母或數字 → 句中還有未被解釋的實義內容 → defer
  return !/[\u3400-\u9fff\u3040-\u30ffA-Za-z0-9]/.test(residue);
}

/**
 * tier-0 判定。回傳 null 代表必須 defer 給模型。
 * 只回意圖；槽位仍交給既有的 reconcileSpec 確定性解析（避免兩套時間邏輯分歧）。
 */
export function fastPathIntent(text: string, groups: string[] = []): Intent | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 60) return null; // 過長句子留給模型，覆蓋檢查易誤判

  // 結構性風險先排除：多需求、指代、明示不要查日曆
  if (looksCompositional(trimmed)) return null;
  const discourse = discourseSignals(trimmed);
  if (discourse.unresolvedReference || discourse.multiple || discourse.discardsPriorContext) return null;
  if (explicitlyDeclinesCalendarLookup(trimmed)) return null;

  // 排序／序數問法（下一個、第一場、最晚那場）帶有 classifyByRules 表達不出的意圖區分
  //（「下一個行程」其實是 next_event，舊規則會粗略歸成 list_events）→ 一律 defer。
  if (new RegExp(ORDINAL_WORDS.source).test(trimmed)) return null;

  if (!deterministicallyCovered(trimmed, groups)) return null;

  const byRules = classifyByRules(trimmed);
  const byMarkers = markerIntent(trimmed);

  // 完全沒有意圖標記、但整句已被解釋完畢，且句中確實有時間表達
  //（「明天傍晚以後呢？」這類省略句）→ 問的就是那段時間有什麼事。
  if (!byMarkers) {
    const hasTimeExpression = new RegExp(TIME_WORDS.source).test(trimmed)
      || new RegExp(WEEKDAY_PHRASE.source).test(trimmed)
      || new RegExp(NUMERIC_TIME.source).test(trimmed);
    // 帶時長表達的句子（「下週一下午給我 90 分鐘」）其實是在要一段空檔，
    // 不是要清單；這種語意差異規則層分不出來 → defer。
    const asksForDuration = durationMinutesFromText(trimmed) !== null;
    if (hasTimeExpression && !asksForDuration && (!byRules || byRules === "list_events")) return "list_events";
    return null;
  }

  // 兩個獨立訊號必須一致才敢跳過模型（品質中立優先於省時）
  if (!byRules || byRules !== byMarkers) return null;
  if (!FAST_PATH_INTENTS.has(byRules)) return null;
  return byRules;
}
