# 站內 agent 路由——LLM 基準配置與 A/B 實測

## 基準配置（實測擇優）
```
model:        Qwen3:14b
mode:         json（withStructuredOutput / JSON schema）
think:        false（enable_thinking:false）
temperature:  0
```
在 `apps/api/src/agents/llm.ts` 為預設；可用環境變數覆蓋做 A/B：
- `INAPP_LLM_MODE=json|tools`（預設 json）
- `INAPP_LLM_THINK=0|1`（預設 0）

## A/B 實測（bench-llm-modes.ts，真 qwen3:14b，temperature 0）

**擴充題庫（49 題，含口語/模糊/混合/多種非日曆）：**

| 配置 | 命中 | 平均延遲 |
|------|------|----------|
| **json + think:off（基準，加 3 條 backstop 後）** | **49/49 (100%)** | **2021 ms/題** |
| json + think:off（backstop 補強前） | 46/49 | 2068 ms/題 |
| tools + think:off（schema 已加描述） | 22/49 (45%) | 9521 ms/題 |

**小題庫（22 題）初測：**

| 配置 | 命中 | 平均延遲 |
|------|------|----------|
| json + think:off | 22/22 | 2017 ms/題 |
| json + think:on | 22/22 | 2015 ms/題 |
| tools + think:off | 13/22 | 2843 ms/題 |
| tools + think:on | 13/22 | 2711 ms/題 |

## 結論與理由
- **json 明顯優於 tools**：qwen3:14b 的原生 tool-calling 對中文意圖分類偏弱——被 `tool_choice` 強制呼叫時，
  新意圖（next_event/event_detail/search_events/events_with_person/compare_load/stats/out_of_scope）
  幾乎全塌成最泛的 `list_events`；JSON structured output 反而讓它認真填 intent。且 json 快約 40%。
- **think:off 對命中率無影響、延遲幾乎相同**：qwen3 在 structured/tool 約束下本就少 emit thinking。
  取 think:off 為基準（無下行風險、輸出更乾淨、避免偶發 `<think>` 干擾解析）。
- **tools 模式保留**：環境變數可切，供日後換更強模型（tool-calling 較佳者）時重跑 bench 比較。

## 重跑基準
```bash
set -a; . ./.env; set +a
export LLM_BASE_URL=http://localhost:11434/v1 OPENAI_API_KEY=local LLM_MODEL=qwen3:14b
pnpm --filter @scal/api exec tsx src/scripts/bench-llm-modes.ts
```
> 注意：務必先確認 ollama 跑在 GPU（`docker exec ollama ollama ps` 顯示 100% GPU），
> 否則延遲數字失真（CPU fallback 單題 10-16s）。
