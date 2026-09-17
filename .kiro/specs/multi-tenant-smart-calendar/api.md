# API 規格：多租戶智慧日曆 SaaS 系統

> 狀態：草案 v0.1 · 最後更新 2026-09-14 · 對應 `requirements.md`

## 通用約定
- 前綴 `/v1`；`Authorization: Bearer <JWT>`。
- `workspace_id` 取自 JWT，不在 URL/body/query（ISO-3）。
- 時間一律 UTC ISO-8601（`Z`）；本地換算在 client（TZ-*）。
- 錯誤 RFC 7807 problem+json。建立類支援 `Idempotency-Key`。
- 跨 workspace 回 404（不洩漏存在性）；同 workspace 越權回 403。

## 路由表

| # | Method | Path | 用途 | Action(PDP) |
|---|---|---|---|---|
| 1 | POST | `/v1/auth/login` | 登入 | — |
| 2 | POST | `/v1/auth/refresh` | 換 access token | — |
| 3 | POST | `/v1/auth/logout` | 撤銷 refresh | — |
| 4 | GET | `/v1/me` | 當前使用者+roles | — |
| 5 | GET | `/v1/members` | 列成員 | `member.read` |
| 6 | POST | `/v1/members/invite` | 邀請 | `member.invite` |
| 7 | PATCH | `/v1/members/{id}` | 改角色/工時/時區 | `member.update` |
| 8 | DELETE | `/v1/members/{id}` | 移除 | `member.remove` |
| 9 | GET | `/v1/calendars` | 列行事曆 | `calendar.read` |
| 10 | POST | `/v1/calendars` | 建立 | `calendar.create` |
| 11 | PATCH | `/v1/calendars/{id}` | 更新 | `calendar.update` |
| 12 | DELETE | `/v1/calendars/{id}` | 刪除 | `calendar.delete` |
| 13 | POST | `/v1/events` | 建立單次/master | `event.create` |
| 14 | GET | `/v1/events/{id}` | 取單筆(不展開) | `event.read` |
| 15 | GET | `/v1/events?from=&to=` | 列表/展開 occurrences | `event.read` |
| 16 | PATCH | `/v1/events/{id}?scope=` | 更新 | `event.update` |
| 17 | PUT | `/v1/events/{id}/occurrences/{recurrenceId}` | 單次例外 | `event.update` |
| 18 | DELETE | `/v1/events/{id}?scope=` | 刪除 | `event.delete` |
| 19 | POST | `/v1/events/parse` | NL→草稿 | `event.create` |
| 20 | GET | `/v1/availability` | 共同空檔 | `availability.read` |
| 21 | POST | `/v1/events/{id}/conflicts` | 衝突+替代 | `event.read` |
| 22 | GET | `/v1/resources` | 列資源 | `resource.read` |
| 23 | POST | `/v1/resources` | 建資源 | `resource.create` |
| 24 | POST | `/v1/resources/{id}/bookings` | 預訂(防雙訂) | `resource.book` |
| 25 | DELETE | `/v1/resources/{id}/bookings/{bid}` | 取消預訂 | `resource.book` |
| 26 | GET | `/v1/events/{id}/reminders` | 列提醒 | `event.read` |
| 27 | POST | `/v1/events/{id}/reminders` | 設會前N分提醒 | `event.update` |
| 28 | DELETE | `/v1/events/{id}/reminders/{rid}` | 移除提醒 | `event.update` |
| 29 | GET/POST/DELETE | `/v1/webhooks` | 管理 webhook | `webhook.manage` |
| 30 | POST | `/v1/integrations/google/connect` | OAuth 連結 | `integration.manage` |

## Agent & MCP 管理端點（Admin，對應 frontend.md §9）

| # | Method | Path | 用途 | Action(PDP) |
|---|---|---|---|---|
| 31 | GET | `/v1/agents` | 列本 workspace 已授權 agent | `agent.manage` |
| 32 | GET | `/v1/agents/{id}` | agent 詳情 + scope + tools | `agent.manage` |
| 33 | DELETE | `/v1/agents/{id}/authorization` | 撤銷授權（即時生效） | `agent.manage` |
| 34 | GET | `/v1/agents/{id}/activity` | 該 agent 稽核動作（分頁） | `agent.manage` |
| 35 | GET | `/v1/audit?actor_type=agent` | MCP 活動時間軸 | `audit.read` |

## 事件 CRUD 語意

**重複事件 scope（PATCH/DELETE）**
| scope | 行為 |
|---|---|
| `this` | 建 exception 列（recurrence_id + master_id）；DELETE→加入 master.exdate |
| `this_and_future` | master rrule 加 UNTIL 截斷 + 建新 master 承接 |
| `all` | 直接改/軟刪 master（級聯 exceptions） |

`scope=this` 需 body/query 帶 `occurrence_start_utc` 定位那一次。

## JSON Schema 範例

### EventInput
```jsonc
{ "required":["calendar_id","title","start_utc","end_utc","timezone"],
  "properties":{
    "calendar_id":{"type":"string"},
    "title":{"type":"string","minLength":1,"maxLength":300},
    "start_utc":{"type":"string","format":"date-time"},
    "end_utc":{"type":"string","format":"date-time"},
    "timezone":{"type":"string","description":"IANA"},
    "rrule":{"type":["string","null"],"description":"RFC 5545; null=單次"},
    "rdate":{"type":"array","items":{"format":"date-time"}},
    "exdate":{"type":"array","items":{"format":"date-time"}},
    "visibility":{"enum":["public","busy","private"],"default":"busy"},
    "location":{"type":["string","null"]},
    "participants":{"type":"array","items":{
      "anyOf":[{"required":["member_id"]},{"required":["guest_email"]}],
      "properties":{"member_id":{"type":"string"},
        "guest_email":{"type":"string","format":"email"},
        "is_organizer":{"type":"boolean","default":false}}}}}}
```

### Event（response）
```jsonc
{ "id","workspace_id","calendar_id","title","description",
  "start_utc","end_utc","timezone",
  "rrule","rdate","exdate","recurrence_id","master_id",
  "kind":{"enum":["single","master","exception"]},
  "visibility":{"enum":["public","busy","private"]},
  "location","participants":[{"member_id","guest_email","is_organizer",
    "response_status":{"enum":["needs_action","accepted","declined","tentative"]}}],
  "source":{"enum":["app","agent","google","m365"]},
  "created_at","updated_at" }
```

### Occurrence（GET events?from&to）
```jsonc
{ "event_id","occurrence_start_utc","occurrence_end_utc","title","timezone",
  "kind":{"enum":["master_instance","exception"]},
  "is_exception":{"type":"boolean"},"exception_id":{"type":["string","null"]} }
```

### AvailabilityResult
```jsonc
{ "slots":[{"start_utc","end_utc","score":0.93,"all_participants_free":true}] }
```

### ReminderInput
```jsonc
{ "required":["lead_minutes"],
  "properties":{"lead_minutes":{"type":"integer","minimum":0},
    "member_id":{"type":["string","null"]},
    "channel":{"enum":["email","push","webhook"],"default":"email"}}}
```

### ConflictProblem（409）
```jsonc
{ "type":"…/errors/conflict","title":"Time conflict","status":409,
  "conflicts":[{"member_id","event_id","start_utc","end_utc"}],
  "suggested_slots":[{"start_utc","end_utc"}] }
```

## 狀態碼
| 碼 | 意義 |
|---|---|
| 403 | 同 workspace 越權 |
| 404 | 不存在或跨 workspace（不洩漏存在性） |
| 409 | 時間/資源衝突（附 suggested_slots） |
| 422 | 驗證失敗（end<=start、IANA、rrule 語法、scope=this 缺 occurrence） |

## 條文（EV-*）
- **EV-1** POST /events 建立單次/master；衝突回 409 + 替代。
- **EV-2** GET /events?from&to 回應用層展開 occurrences；不展開存 DB。
- **EV-3** PATCH/DELETE 以 scope 實作 RFC 5545 修改語意。
- **EV-4** 單次例外以 recurrence_id+master_id；取消用 exdate。
- **EV-5** 預設軟刪；跨 ws 一律 404；寫操作記稽核並觸發通知佇列。
