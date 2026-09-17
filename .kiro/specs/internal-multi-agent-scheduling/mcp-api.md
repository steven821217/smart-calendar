# 內部多智能體協作系統 — MCP Tool 契約

## Tool: `delegate_complex_scheduling`

高階委派型 tool：外部 Agent 只描述任務，內部委員會（LangGraph）完成排程。

### Scope（`TOOL_SCOPE`）
進入以 `event.write` 為主要 scope 註冊；`toolDelegateComplexScheduling` 另聚合斷言需同時具備：
- `availability.read`（找時段）
- `event.write`（建立事件）
- `resource.book`（預訂資源）

任一缺失 → `insufficient_scope`，全程不落實。

### Input
```jsonc
{
  "task_description": "幫我跟 Bob 借一輛公務車去拜訪客戶，時間在下週三下午", // 必填
  "reference_now_utc": "2026-09-15T03:57:00Z",   // 選填，相對時間解析基準；預設 = server now
  "default_timezone": "Asia/Taipei",              // 選填，預設取呼叫者/工作區設定
  "confirm": false,                                // 選填，預設 false（不落實，僅預覽/談判）
  "explain": false                                 // 選填，true=dry-run：回各節點決策軌跡，絕不寫 DB（功能 B）
}
```
- `workspace` / `sub` **不接受**由參數傳入，一律取自 token（ZT-5）。

### Output（依終態擇一）

`booked`（confirm=true 且無衝突）：
```jsonc
{
  "status": "booked",
  "result": {
    "event": { "id": "...", "start_utc": "...", "end_utc": "...", "source": "agent" },
    "booking": { "id": "...", "resource_id": "...", "start_utc": "...", "end_utc": "..." }, // 含 buffer 的實際寫入區間
    "actual_usage": { "start_utc": "...", "end_utc": "..." },                                // 扣回 buffer 的使用時段
    "reminders": [ { "id": "...", "lead_minutes": 30, "channel": "email" } ]                 // 功能 A：自動掛的提醒
  }
}
```

`explain`（`explain=true`，dry-run，不寫 DB — 功能 B）：
```jsonc
{
  "status": "needs_decision",          // 或其他非 booked 終態
  "explain": true,
  "trace": [
    { "node": "coordinator", "note": "解析出 attendees=[Bob], vehicle 需求, 下週三下午" },
    { "node": "negotiator", "note": "3 候選，最高分 0.93" },
    { "node": "resourceManager", "note": "首選被 buffer 擋（前一筆 14 分前結束），退回備案" }
  ]
}
```

`needs_decision`（衝突有備案，或 confirm=false 的預覽）：
```jsonc
{
  "status": "needs_decision",
  "require_confirmation": true,
  "options": [                       // 最多 3
    { "start_utc": "...", "end_utc": "...", "score": 0.93 }
  ],
  "preview": { "resource_id": "...", "attendees": ["..."] },
  "note": "re-call with confirm=true and a chosen slot to book"
}
```

`needs_clarification`（Coordinator 無法解析）：
```jsonc
{ "status": "needs_clarification", "message": "找不到唯一對應的成員 'Bob'，請提供 member_id 或完整姓名" }
```

`error`（無可用時段、LLM 不可用、落實失敗）：
```jsonc
{ "status": "error", "message": "指定窗口內無可用時段", "code": "no_availability" }
```

### 授權失敗（沿用 guard 既有語意）
| 情況 | 對映 |
| --- | --- |
| 無/失效 token | `unauthorized` |
| scope 不足 | `insufficient_scope` |
| PDP 拒絕 / 跨 workspace | `forbidden`（跨 workspace 對外表現為 not_found，不洩漏存在性） |
| agent 被撤銷 | `forbidden`（revoked） |

### 稽核
每次實際落實（createEvent / bookResource）寫 `audit_log`：`actor_type=agent`, `agent_id=sub`,
`source=agent`, `metadata.tool="delegate_complex_scheduling"`。

## 與既有 tool 的關係
- 本 tool **不取代** 既有低階 tool（`find_available_time_slots` / `create_smart_event` /
  `book_resource` …），而是提供高階入口；兩者共用同一 Service 層與授權鏈。
- 內部節點呼叫 Service 時不重複走 MCP guard（已在入口守過一次），但仍受 RLS/PDP 於 Service/DB 層約束。
