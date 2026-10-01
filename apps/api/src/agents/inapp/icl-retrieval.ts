import { FAMILY_EXAMPLES, type FamilyExample } from "./example-bank.js";

/**
 * Query-conditioned ICL 檢索（訓練-free，不動模型權重）。
 *
 * 做法：用本機 embedding 模型把使用者句子與示例庫向量化，取語意最近的示例注入第一層
 * 路由提示。與「加關鍵字規則」的差別在於比對是語意相似度，新措辭也能對到最接近的示範。
 *
 * 可靠性設計：
 *  - 示例庫向量只算一次並常駐記憶體（in-process cache）。
 *  - 任一步失敗（embedding 服務不可用、維度不符）→ 回空陣列，退回 zero-shot，絕不卡住路由。
 *  - 取 top-k 後做輕量 MMR：同一 family 最多 2 筆，確保提示裡保留「對照組」而不是同類重複。
 */
const EMBED_MODEL = process.env.INAPP_EMBED_MODEL || "embeddinggemma:latest";
/** 示例數量（0 = 關閉 ICL）。few-shot 數量非單調，預設值由基準實測決定。 */
export const ICL_K = Number.parseInt(process.env.INAPP_ICL_K ?? "4", 10);
const EMBED_TIMEOUT_MS = Number.parseInt(process.env.INAPP_EMBED_TIMEOUT_MS ?? "1500", 10);

let bankVectors: number[][] | null = null;
let bankInitFailed = false;

function embedEndpoint(): string | null {
  const base = process.env.LLM_BASE_URL || "";
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/embeddings`;
}

async function embed(inputs: string[]): Promise<number[][] | null> {
  const url = embedEndpoint();
  if (!url || inputs.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 本機 ollama 不驗證，但雲端 OpenAI 相容端點需要；沿用既有金鑰設定。
        ...(process.env.OPENAI_API_KEY ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const rows = json.data;
    if (!Array.isArray(rows) || rows.length !== inputs.length) return null;
    const out: number[][] = [];
    for (let i = 0; i < rows.length; i++) {
      const vec = rows[i]?.embedding;
      if (!Array.isArray(vec) || vec.length === 0) return null;
      out[rows[i]?.index ?? i] = vec;
    }
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function ensureBank(): Promise<number[][] | null> {
  if (bankVectors) return bankVectors;
  if (bankInitFailed) return null;
  const vectors = await embed(FAMILY_EXAMPLES.map((e) => e.text));
  if (!vectors) {
    bankInitFailed = true;
    return null;
  }
  bankVectors = vectors;
  return bankVectors;
}

/** 測試用：重設快取狀態。 */
export function resetIclCache(): void {
  bankVectors = null;
  bankInitFailed = false;
}

/** 依語意相近度挑出示範；失敗或關閉時回空陣列（zero-shot）。 */
export async function retrieveFamilyExamples(text: string, k: number = ICL_K): Promise<FamilyExample[]> {
  if (!Number.isFinite(k) || k <= 0) return [];
  const bank = await ensureBank();
  if (!bank) return [];
  const queryVec = await embed([text]);
  if (!queryVec?.[0]) return [];
  const scored = FAMILY_EXAMPLES.map((example, i) => ({ example, score: cosine(queryVec[0], bank[i] ?? []) }))
    .sort((a, b) => b.score - a.score);

  // 輕量 MMR：同 family 最多 2 筆，讓提示同時帶到容易混淆的對照組。
  const perFamily = new Map<string, number>();
  const picked: FamilyExample[] = [];
  for (const { example } of scored) {
    const used = perFamily.get(example.family) ?? 0;
    if (used >= 2) continue;
    perFamily.set(example.family, used + 1);
    picked.push(example);
    if (picked.length >= k) break;
  }
  return picked;
}

const FAMILY_TO_LABEL: Record<string, string> = {
  agenda: "existing_events",
  availability: "free_time",
  people: "team_or_person",
  analytics: "aggregate_stats",
  mutation: "modify_calendar",
  out_of_scope: "not_calendar",
};

/** 把示範格式化成極短的提示片段（控制 prefill 成本）。 */
export function formatFamilyExamples(examples: readonly FamilyExample[]): string {
  if (examples.length === 0) return "";
  const lines = examples.map(
    (e) => `「${e.text}」→ family=${FAMILY_TO_LABEL[e.family] ?? e.family}, request_count=${e.request_count}`,
  );
  return `\n語意相近的已判定範例（僅供類比，實際仍以使用者這句為準）：\n${lines.join("\n")}`;
}
