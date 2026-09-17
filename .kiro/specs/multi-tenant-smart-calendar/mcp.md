# MCP 整合設計：多租戶智慧日曆 SaaS 系統

> 狀態：草案 v0.1 · 最後更新 2026-09-14 · 對應 `requirements.md`、`security.md`

## 1. 定位
以 `@modelcontextprotocol/sdk`(TS) 建本機 MCP Server，把日曆能力以 tools/resources 暴露給外部 AI Agent，代使用者自動排程。每個 tool = 一個 PEP，複用與 REST 相同的授權鏈（ZT-*）。

## 2. Exposed Tools

全 tool：**無 `workspace_id` 參數**（脈絡來自連線憑證）；時間 UTC ISO-8601 + IANA timezone。

| # | Tool | 用途 | 寫 | Action | scope |
|---|---|---|---|---|---|
| 1 | `find_available_time_slots` | 找共同空檔 | 否 | availability.read | availability.read |
| 2 | `create_smart_event` | 建立事件(自動衝突檢查) | 是 | event.create | event.write |
| 3 | `resolve_scheduling_conflict` | 解衝突+替代方案 | 視 | event.read/update | event.write |
| 4 | `update_event_occurrence` | 改重複某次(exception) | 是 | event.update | event.write |
| 5 | `book_resource` | 預訂資源(防雙訂,可要確認) | 是 | resource.book | resource.book |
| 6 | `parse_event_from_text` | NL→草稿 | 否 | event.create | event.write |
| 7 | `list_event_occurrences` | 展開窗口 occurrences | 否 | event.read | availability.read |

**Resources（唯讀）**：`calendar://{id}`、`event://{id}`（讀取經 PDP + RLS）。

**zod schema 摘要**
```ts
find_available_time_slots({ participant_member_ids:string[], guest_emails?:string[],
  from_utc, to_utc, duration_minutes:int>0, resource_ids?:string[],
  max_results?=5, respect_working_hours?=true })
create_smart_event({ calendar_id, title, start_utc, end_utc, timezone,
  rrule?, participant_member_ids?, guest_emails?, resource_ids?,
  visibility?='busy', location?, on_conflict?='suggest_alternatives', idempotency_key? })
resolve_scheduling_conflict({ event_id,
  strategy?='earliest_available'|'minimize_disruption'|'keep_organizer_preference',
  search_window_utc:{from,to}, max_options?=3 })
update_event_occurrence({ event_id, recurrence_id_utc, new_start_utc?, new_end_utc?,
  title?, is_cancelled?=false })
book_resource({ resource_id, event_id, start_utc, end_utc, require_confirmation?=true })
parse_event_from_text({ text, reference_now_utc?, default_timezone })
list_event_occurrences({ calendar_id?, from_utc, to_utc })
```

## 3. 外部 Agent 接入（OAuth 2.1）

```
使用者 —consent(勾 scope)→ Authorization Server
   → 發 M2M token: sub, workspace, roles, scope
Agent —Bearer token→ MCP Server(Streamable HTTP)
   → handshake 回傳 scope 過濾後的 tools
```
- token 綁 sub/workspace/roles/scope；使用者可隨時撤銷（即時生效）。
- consent 預設只勾唯讀；寫入類需明確加勾（最小授權）。

## 4. 每次 tool call 零信任序列
```
[1] AuthN 驗 token(簽章/exp/撤銷)   失敗→unauthorized
[2] Scope: tool ∈ token.scope       否→insufficient_scope
[3] PEP→PDP authorize() 重新求值     deny→forbidden/not-found
[4] Service: SET LOCAL app.current_workspace
[5] Repository: SQL(RLS 兜底)
[6] Audit: actor_type='agent', on_behalf_of=sub, agent_id, decision
```
權限 = scope ∩ role（取交集）。

## 5. 自動排程閉環
```
1. find_available_time_slots → slots(私密僅 free/busy)
2. Agent 選時段
3. create_smart_event(on_conflict=suggest_alternatives, idempotency_key)
     成功→created(入 BullMQ 通知/提醒, source=agent)
     衝突→conflict + suggested_slots
4. resolve_scheduling_conflict → resolutions
5. create_smart_event(同 idempotency_key) → created
6. (選) book_resource(require_confirmation=true) → 提案待確認
```

## 6. 傳輸與部署
- 本機/桌面 agent：stdio。
- 對外：Streamable HTTP，經 gateway(TLS + rate-limit + token 驗證)；`mcp` service 不直接對公網。

## 7. 條文（MCP-* / TOOL-*）
- **MCP-1** MCP Server 以 SDK(TS)；tool schema zod，與 packages/shared 共用。
- **MCP-2** 每 tool handler = PEP，先 authorize 後才呼叫 Service（禁旁路）。
- **MCP-3** workspace/sub 僅來自連線憑證；tool 參數不含 workspace_id。
- **MCP-4** agent 能力上限 = 被代理者權限；可再以 scope 收斂。
- **MCP-5** MCP 動作記稽核（actor_type=agent + on_behalf_of），event source=agent。
- **MCP-6** tool 存取經 Service→Repository，SET LOCAL workspace + RLS。
- **MCP-7** 對外 Streamable HTTP 帶授權標頭；本機 stdio。
- **MCP-8** 第三方 agent 經 OAuth 2.1 取代理 token，可隨時撤銷。
- **MCP-9** 每次先 scope 檢查再 PDP；權限 = scope ∩ role。
- **MCP-10** 對外經 gateway；mcp service 不直接對公網。
- **MCP-11** find_availability 對外部 agent 僅回 free/busy。
- **MCP-12** book_resource 等敏感動作可 require_confirmation。
- **MCP-13** 所有 agent 動作記稽核。
- **TOOL-1..5** 見上表與 schema；寫入類支援 idempotency_key，衝突回結構化 conflicts+suggested_slots。
