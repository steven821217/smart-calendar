package calendar.authz

# 預設拒絕（deny-by-default）
default allow := false

# admin：本 workspace 內全能
allow if {
	input.subject.roles[_] == "admin"
	input.resource.workspace == input.subject.workspace
}

# 本人可讀/改/刪自己建立的事件
allow if {
	input.action in {"event.read", "event.update", "event.delete"}
	input.resource.owner_id == input.subject.sub
	input.resource.workspace == input.subject.workspace
}

# 任何成員可建立事件（在自己 workspace）
allow if {
	input.action == "event.create"
	input.resource.workspace == input.subject.workspace
	count({r | some r in input.subject.roles; r in {"admin", "scheduler", "member"}}) > 0
}

# 空檔查詢：本 workspace 任何成員可讀
allow if {
	input.action == "availability.read"
	input.resource.workspace == input.subject.workspace
}

# 列行事曆：本 workspace 任何成員可讀
allow if {
	input.action == "calendar.read"
	input.resource.workspace == input.subject.workspace
	count({r | some r in input.subject.roles; r in {"admin", "scheduler", "member"}}) > 0
}

# scheduler 可預訂資源
allow if {
	input.action == "resource.book"
	input.resource.workspace == input.subject.workspace
	count({r | some r in input.subject.roles; r in {"admin", "scheduler"}}) > 0
}

# 列資源：本 workspace 任何成員可讀
allow if {
	input.action == "resource.read"
	input.resource.workspace == input.subject.workspace
	count({r | some r in input.subject.roles; r in {"admin", "scheduler", "member"}}) > 0
}

# 建資源：admin / scheduler
allow if {
	input.action == "resource.create"
	input.resource.workspace == input.subject.workspace
	count({r | some r in input.subject.roles; r in {"admin", "scheduler"}}) > 0
}

# 讀 public / busy 可見度的事件（本 workspace）
allow if {
	input.action == "event.read"
	input.resource.workspace == input.subject.workspace
	input.resource.visibility in {"public", "busy"}
}

# 列表讀取（未指定單一資源 owner/visibility）：本 workspace 成員可讀，
# 細粒度可見性由資料層 RLS + visibility 過濾（private 對非參與者僅顯示 busy）
allow if {
	input.action == "event.read"
	input.resource.workspace == input.subject.workspace
	not input.resource.owner_id
	not input.resource.visibility
	count({r | some r in input.subject.roles; r in {"admin", "scheduler", "member"}}) > 0
}

# agent/audit 管理：僅 admin
allow if {
	input.action in {"agent.manage", "audit.read"}
	input.subject.roles[_] == "admin"
	input.resource.workspace == input.subject.workspace
}

# webhook 管理：僅 admin（本 workspace）
allow if {
	input.action == "webhook.manage"
	input.subject.roles[_] == "admin"
	input.resource.workspace == input.subject.workspace
}

# 團隊群組（feature-team-groups）
# 讀群組：本 workspace 任何成員
allow if {
	input.action == "group.read"
	input.resource.workspace == input.subject.workspace
	count({r | some r in input.subject.roles; r in {"admin", "scheduler", "member"}}) > 0
}

# 管理群組（建立/刪除/成員增減）：admin / scheduler
allow if {
	input.action == "group.manage"
	input.resource.workspace == input.subject.workspace
	count({r | some r in input.subject.roles; r in {"admin", "scheduler"}}) > 0
}

# Leader 可讀其 Member 的空檔（Req 1.3）：本 workspace 內 availability.read 已對成員開放，
# 此處明列 leader 語意以供未來收斂（leader 亦為成員）。實際「不得不經同意強佔時間」
# 由委員會將 Member 設為 rsvp_status='pending' + Member 端 accept 才正式排入保證，非 OPA 層。
allow if {
	input.action == "availability.read"
	input.resource.workspace == input.subject.workspace
	input.subject.roles[_] == "scheduler"
}
