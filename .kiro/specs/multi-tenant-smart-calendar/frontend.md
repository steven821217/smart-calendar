# 前端 UI/UX 設計：多租戶智慧日曆 SaaS 系統

> 狀態：草案 v0.1 · 最後更新 2026-09-14 · 對應 `requirements.md`（Req 5）、`design.md`、`api.md`、`security.md`

## 1. 技術棧（前端層，定案）
| 面向 | 選型 |
|---|---|
| 建置 | React + Vite + TypeScript（SPA） |
| 樣式 | Tailwind CSS + shadcn/ui（Radix 底層） |
| 圖示 | lucide-react（唯一 icon set） |
| 日曆網格 | **CSS Grid 自刻**（不用 FullCalendar） |
| 日期/時區計算 | date-fns + date-fns-tz（headless，IANA） |
| 拖曳 | @dnd-kit/core（+ modifiers） |
| 動畫 | framer-motion |
| Toast | sonner |
| 主題 | next-themes（class 策略，light/dark/system） |
| 伺服器狀態 | TanStack Query |
| client 狀態 | Zustand |
| 表單 | React Hook Form + zod（共用 packages/shared） |
| 路由 | React Router |
| i18n | react-i18next |
| 變體 | class-variance-authority + tailwind-merge |

## 2. 頁面架構（路由）
```
/login
/calendar                  主日曆（日/週/月）
/calendar/event/:id        事件詳情 drawer
/availability              找時間（多人空檔）
/resources                 資源列表/預訂（Scheduler/Admin）
/settings/profile          時區、工作時間、預設提醒
/settings/members          成員/角色（Admin）
/settings/integrations     外部日曆、Webhook
/settings/agents           🤖 Agent & MCP 管理（Admin only）
```

## 3. 元件樹（核心）
```
<AppShell> 側欄 + 頂欄 + workspace 標示
├─ <Sidebar>  導覽 + 行事曆清單；Admin 顯示「Agent & MCP 管理」
├─ <TopBar>   日期導覽 + 視圖切換 + 「+ 建立」+ 主題切換 + 使用者選單
└─ <CalendarView>（自刻 CSS Grid）
   ├─ <MonthGrid> / <WeekGrid>
   ├─ <EventChip>（draggable, 依 visibility/回覆狀態著色）
   ├─ <CreateEventDialog>
   │   ├─ <RecurrenceEditor>（RRULE 產生器）
   │   ├─ <ParticipantPicker>（成員 + guest）
   │   ├─ <ReminderEditor>（多重會前 N 分鐘）
   │   └─ <AvailabilityPanel>（空檔卡片）
   ├─ <EventDetailDrawer>（詳情 + 回覆 + scope 編輯）
   ├─ <ScopeChooser>（this / this_and_future / all）
   └─ <NLQuickAdd>（自然語言 → 草稿）
```

## 4. 日曆網格：CSS Grid 自刻 + date-fns
- 不用 FullCalendar/react-big-calendar（重、非 headless）。視圖 UI 自刻（React + CSS Grid + Tailwind）。
- **月視圖**：`grid-cols-7 auto-rows-fr`，date-fns `eachDayOfInterval(startOfWeek(startOfMonth)…)` 產 42 格；非本月淡化、今天高亮。
- **週視圖**：`grid-cols-[auto_repeat(7,1fr)]` + 時間軸；事件以分鐘 offset 定位；重疊事件 column packing 等分欄寬。
- **時區**：後端存/回 UTC，前端僅用 date-fns-tz 依觀看者 IANA 換算顯示，不自行加減時差；DST 由 date-fns-tz 處理。
- **重複展開**：由後端 `GET /events?from&to` 回 occurrences（REC-2），前端只落格。

## 5. 拖曳（@dnd-kit/core）
- `DndContext` 包日曆；`EventChip`=useDraggable、日期/時段=useDroppable；`DragOverlay` 預覽。
- **月視圖** snap 到日格（換日期保留時間）；**週視圖** snap 15 分（換日期+時段保留時長）。
- 落點依觀看者 IANA 換算算新 start_utc；重複事件先跳 ScopeChooser。
- 樂觀更新 → `PATCH /events/:id?scope=…` → 409 回滾 + suggested_slots；成功後後端重排提醒。
- a11y：KeyboardSensor（Space 抓取/方向鍵/Esc）+ announcements；PointerSensor activation constraint（觸控）。

## 6. 設計系統與元件庫
- **Tailwind 全面**：禁手寫 CSS/inline style（例外註記）。變體用 cva + tailwind-merge，`cn()` = clsx + tailwind-merge。
- **shadcn/ui + Radix**：互動元件（Dialog/Sheet/Popover/DropdownMenu/Select/Tabs/Tooltip）不自造裸元素。
- **lucide-react**：唯一圖示；裝飾 `aria-hidden`，語意配 aria-label/文字。常用：Calendar/Clock/Users/Bell/Repeat/Lock/Bot。
- 目錄：`components/ui/`（shadcn，擁有原始碼）、`components/calendar/`（衍生）、`lib/utils.ts`、`styles/globals.css`。

## 7. 視覺美學
- **Vercel/Linear 極簡**：中性色為主、accent 節制、裝飾克制、細邊框、微互動。
- **字體 Inter**（自託管）+ 系統無襯線 fallback；標題 `tracking-tight`，內文 `leading-relaxed`。
- **Dark/Light/system**：class 策略 + CSS variable（HSL）token，無 FOUC，兩主題皆達 WCAG AA。
- **留白充足**：8pt 基準（Tailwind scale），卡片舒展 padding，區塊 `space-y-6/8`。

## 8. 狀態回饋
- 每個非同步寫入：pending（disabled + Loader2 spinner + 樂觀更新）→ 成功/失敗 Toast（sonner）→ 失敗回滾。
- 409 衝突 Toast 附「查看建議時段」action；破壞性動作 toast undo。
- **Skeleton**：日曆格、空檔卡片、清單；形狀貼近內容、避免 layout shift；<200ms 抑制閃爍。
- **framer-motion**：進出場（AnimatePresence）、拖曳落定（layout/layoutId）、drawer stagger；150–250ms ease-out；尊重 prefers-reduced-motion。
- 統一 `useMutationWithFeedback` 包裝（pending/toast/回滾一致）。

## 9. Agent & MCP 管理介面（Admin 專屬）
- 側邊欄 `/settings/agents`（Admin only）：視覺化審查外部 AI 對本 workspace 的授權。
- **區塊**：已授權 agent 清單（名稱/代理使用者/scope/最後活動/狀態/撤銷）、agent 詳情 Drawer（scope/tools/稽核/呼叫量）、MCP 活動時間軸（allow/deny 標色）、scope 總覽。
- **操作**：一鍵撤銷（Redis 黑名單即時生效，MCP-8）+ 二次確認 + toast undo；點動作展開稽核（subject/action/resource/decision）。
- **範圍**：經 `agent.manage`（admin）+ RLS，只見本 workspace，不洩漏私密內容。
- **API**：`GET /v1/agents`、`GET /v1/agents/{id}`、`DELETE /v1/agents/{id}/authorization`、`GET /v1/agents/{id}/activity`、`GET /v1/audit?actor_type=agent`。

## 10. 多租戶 & 隱私 UX
- workspace 唯讀標示，使用者不能於 UI 切換（ISO-3）。
- private 事件對非參與者僅顯示 Busy；空檔結果對他人只反映 free/busy。
- agent 建立的事件詳情顯示「由 Agent X 代排」（source=agent）。

## 11. 條文（UI-*）
- **UI-1** React+Vite+TS+Tailwind+shadcn/ui；型別共用 packages/shared。
- **UI-2** 時間依觀看者 IANA 顯示；跨時區雙時區；不自行加減時差。
- **UI-3** workspace 唯讀，不能於 UI 切換。
- **UI-4** 拖拉/回覆樂觀更新，409 回滾 + suggested_slots。
- **UI-5** 重複事件編輯/刪除提供 this/this_and_future/all。
- **UI-6** private 對非參與者僅顯示 Busy。
- **UI-7** WCAG AA、鍵盤可操作、完整 i18n。
- **UI-8** Agent 授權/scope/撤銷入口，agent 事件標示來源。
- **UI-9** Tailwind 全面，禁手寫 CSS/inline style（例外註記）。
- **UI-10** 互動元件基於 shadcn/Radix，不自造裸元素。
- **UI-11** 圖示僅 lucide-react；裝飾 aria-hidden、語意附 label。
- **UI-12** 顏色/圖示非唯一資訊；變體用 cva + tailwind-merge。
- **UI-13** Vercel/Linear 極簡風。
- **UI-14** Dark/Light/system，class 策略，無 FOUC，WCAG AA。
- **UI-15** 字體 Inter（自託管）+ 系統 fallback。
- **UI-16** 留白充足，8pt 基準；動效尊重 prefers-reduced-motion。
- **UI-17** 日曆月/週視圖 CSS Grid 自刻，不用 FullCalendar。
- **UI-18** 日期/時區用 date-fns/date-fns-tz，依觀看者 IANA。
- **UI-19** 重複 occurrence 後端展開，前端僅落格。
- **UI-20** 拖曳用 @dnd-kit/core，DragOverlay 預覽。
- **UI-21** 拖曳落點依 IANA 算 start_utc，重複先選 scope，樂觀更新 + 409 回滾。
- **UI-22** 拖曳支援鍵盤 + 螢幕閱讀器公告，PointerSensor activation constraint。
- **UI-23** 非同步寫入具 pending/Toast/回滾；409 Toast 附建議時段 action。
- **UI-24** 載入用 Skeleton，避免 layout shift，抑制短查詢閃爍。
- **UI-25** 微動畫用 framer-motion（150–250ms ease-out），尊重 reduced-motion；Toast live region 公告。
- **UI-26** 側邊欄 Admin 專屬 Agent & MCP 管理，列授權 agent 並即時撤銷。
- **UI-27** 該介面呈現 agent 稽核與 MCP 活動，經 agent.manage + RLS，不跨 workspace、不洩漏私密內容。
