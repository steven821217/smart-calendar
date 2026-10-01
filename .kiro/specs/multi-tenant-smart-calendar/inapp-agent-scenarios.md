# 站內/外部 agent 情境盤點（function 覆蓋率 + 非日曆擋掉）

目的：讓 qwen3:14b 只做「問句 → 選 function + 抽參數」，真實答案由確定性 function 產生，
最後 14B 潤飾。本清單盤點 user 會對日曆說的話，標示**現況覆蓋**與**缺口**，供圈選要 function 化的項目。

圖例：✅ 已支援　🟡 部分/不精確　❌ 未支援（需新 function）　🛡️ 需擋掉

---

## A. 現有 6 個意圖（function）已覆蓋

| # | 意圖 | function | 範例問句 | 狀態 |
|---|------|----------|----------|------|
| A1 | list_events | `listOccurrencesForMember(from,to)` | 今天有什麼會、明天的行程、這週三到週五有哪些 | ✅ |
| A2 | count_events | 同上 + 計數 | 這週幾個會、今天忙不忙、這個月幾個 | ✅ |
| A3 | find_free | `computeAvailability(from,to,60,[me])` | 明天下午有空嗎、哪個時段是空的 | 🟡 只找 60 分、無「最近一個」 |
| A4 | list_pending | `listPendingForMember` | 誰約我還沒回、待處理的邀請 | ✅ |
| A5 | list_members | `listGroups/listGroupMembers` | 我的組員有誰、產品團隊有哪些人 | ✅ |
| A6 | schedule | 委員會 | 幫我約明天下午開會、訂週四公務車 | ✅ |

---

## B. 缺口：user 很可能會問，但目前答不精確或答不了（候選新 function）

### B1. 事件細節查詢 ❌ — 「那個會在哪開／幾點到幾點／有誰參加／多久」
- 「明天的產品週會在哪開？」「下午那個會開多久？」「週會有誰要來？」
- 現況：list 只回「日期 時間 標題」，沒有 location/end/attendees/duration。
- 需要：`getEventDetail(occurrence)` — 回地點、起訖、時長、與會者、來源、RSVP 狀態。

### B2. 下一個/即將到來 🟡 — 「我接下來要幹嘛／下一個會是什麼／等一下有事嗎」
- 「我等一下有什麼事？」「下一個會幾點？」「再來是什麼行程？」
- 現況：order=first 只在單一窗內；「下一個」跨窗（現在起最近一筆）沒有明確 function。
- 需要：`nextEvent(from=now)` — 現在時間起最近的 1~N 筆。

### B3. 關鍵字/全域搜尋 ❌ — 「我上次跟客戶的會是什麼時候／有沒有排過 X」
- 「我跟客戶的會排在哪天？」「有沒有牙醫的預約？」「上次 review 是什麼時候？」
- 現況：filter_keyword 只在已選定的時間窗內；沒有「不限時間、依標題找」。
- 需要：`searchEvents(keyword, range=all/未來/過去)` — 跨時間找標題含關鍵字的事件。

### B4. 依人查（關係型）❌ — 「我跟 Mia 有沒有約／下次跟老闆碰面是何時」
- 「我跟 Mia 下次什麼時候見？」「我這週有跟產品團隊的人開會嗎？」
- 現況：group 過濾有，但「跟某個人」（單一 member）沒有。
- 需要：`eventsWithPerson(personName, range)` — 找雙方都在 participant 的事件。

### B5. 指定時長/條件的空檔 🟡 — 「幫我找 2 小時的空／下週有沒有半天空」
- 「明天有沒有連續 2 小時的空？」「下週哪天整個下午都空？」
- 現況：find_free 寫死 60 分。
- 需要：find_free 支援 `duration_minutes`（14B 抽時長）＋「整段時段全空」語意。

### B6. 最近一個空檔 🟡 — 「我最快什麼時候有空／離現在最近的空檔」
- 現況：computeAvailability 回窗內多筆，但沒有「現在起第一個可用」語意。
- 需要：`nextFreeSlot(from=now, duration)`。

### B7. 比較/趨勢 ❌ — 「這週比上週忙嗎／這個月開會變多了嗎」
- 現況：無比較 function。
- 需要：`compareLoad(windowA, windowB)` — 回兩窗數量/時數差。低優先（較進階）。

### B8. 統計/模式 ❌ — 「我平均一天幾個會／我最忙的是星期幾／下午通常在開會嗎」
- 現況：無統計 function。
- 需要：`stats(range, groupBy=day/weekday/daypart)`。低優先。

### B9. 修改/取消既有事件 ❌ — 「把明天的會改到後天／取消週五那場」
- 現況：站內 agent **只讀**；`updateEvent/deleteEvent` function 存在但沒接進對話 agent。
- 需要：新意圖 `reschedule` / `cancel` → 走委員會或直接 service（**破壞性，需二次確認**，比照 book_resource 的 confirm 語意）。⚠️ 授權/確認要謹慎。

### B10. RSVP 動作 🟡 — 「幫我接受產品週會的邀請／回覆那個邀請」
- 現況：`POST /v1/events/:id/rsvp` 有，但對話 agent 不能觸發（只能 list_pending）。
- 需要：新意圖 `respond_rsvp(event, accept/decline)`。

### B11. 依地點/資源查 ❌ — 「哪些會在 A 會議室／今天用到公務車的行程」
- 需要：`eventsByResource/Location`。中低優先。

### B12. 空泛/寒暄但仍屬日曆 🟡 — 「我最近怎麼樣／幫我看看行程」
- 現況：anchor=none → 預設 7 天窗（已加 E 追問可選）。
- 建議：保持預設窗 or 追問，不需新 function。

---

## C. 非日曆問題 → 直接擋掉 🛡️（你要求的新增）

user 可能問與日曆無關的話，應**在 14B 路由層就辨識並禮貌擋掉**，不浪費後端查詢、也不讓 14B 亂答。

### C1. 設計：新增路由意圖 `out_of_scope`
- 14B 的 RouteSchema 意圖 enum 增加 `out_of_scope`（第 7 類）。
- prompt 明確：問句與「本人日曆／行程／會議／空檔／團隊成員／排會」無關者 → `out_of_scope`。
- service 對 `out_of_scope` 回固定訊息（不查 DB、不潤飾）：
  「我是你的日曆助理，只能幫你查行程、找空檔、看團隊成員或安排會議。這個問題我幫不上，換個跟行事曆有關的問法試試？」

### C2. 應擋掉的例子
- 常識/百科：「今天天氣如何」「幫我寫一首詩」「Python 怎麼寫 for loop」「1+1=?」
- 閒聊：「你是誰做的」「講個笑話」「你喜歡什麼」
- 越權/危險：「幫我看別人的行程」（已被個人隔離擋在 DB 層，但語意上也可先擋）
- 其他系統：「幫我訂機票」「發個 email 給老闆」（非日曆動作）

### C3. 護欄（避免誤擋真日曆問題）
- backstop：即使 14B 判 out_of_scope，若原文含明確日曆詞（會/行程/空/約/團隊/邀請/星期X…）→ 覆核回查詢意圖（寧可查也不要誤擋真問題）。
- 反向：14B 判日曆意圖但完全無日曆線索且像閒聊 → 可選擇性追問或擋。
- 一律**保守**：擋掉的成本（user 覺得笨）高於偶爾多查一次，故 backstop 只單向「擋→放行」。

---

## D. 建議優先序（投報率）

**第一波（高頻、低風險、純讀）：** B1 事件細節、B2 下一個、B3 關鍵字搜尋、B5/B6 空檔加強、C 非日曆擋掉
**第二波（關係/統計）：** B4 依人查、B8 統計、B7 比較
**第三波（破壞性、需確認）：** B9 改期/取消、B10 RSVP 動作、B11 資源查

> 每個新 function 都：定義 service function（確定性、可測）→ 加進 RouteSchema 意圖/參數 →
> reconcile/backstop 覆核 → facts 化供潤飾 → 真 14B probe 驗證 → 單元/整合測試鎖 CI。
> MCP `query_calendar` 因共用 `runInAppAgent`，全部自動同步（唯破壞性動作需評估是否開放外部 agent）。
