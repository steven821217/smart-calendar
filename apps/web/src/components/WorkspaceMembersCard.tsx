import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Users, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/store/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/feedback";

/** 將已註冊使用者加入目前工作區；新成員預設仍受個人日曆隔離。 */
export function WorkspaceMembersCard() {
  const me = useAuth((state) => state.me)!;
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "scheduler" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const rosterQ = useQuery({
    queryKey: ["ws-members", me.workspace.id],
    queryFn: () => api.listWorkspaceMembers(),
  });

  const submit = async () => {
    const value = email.trim().toLowerCase();
    if (!value || busy) return;
    setBusy(true);
    setErr(null);
    setOkMsg(null);
    try {
      const member = await api.addWorkspaceMember(value, role);
      setOkMsg(`已把 ${member.email} 加入這個工作區（${member.role}）。`);
      setEmail("");
      await qc.invalidateQueries({ queryKey: ["ws-members"] });
    } catch (error) {
      setErr(error instanceof ApiError ? (error.detail ?? error.title) : "加入失敗");
    } finally {
      setBusy(false);
    }
  };

  const members = rosterQ.data?.members ?? [];

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5" aria-labelledby="workspace-members-heading">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Users className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="workspace-members-heading" className="text-base font-semibold tracking-tight">工作區成員</h2>
          <p className="text-xs text-muted-foreground">目前 {members.length} 人</p>
        </div>
      </div>

      <p className="max-w-4xl text-sm leading-6 text-muted-foreground">
        輸入對方的電子郵件以將其加入工作區。如果是尚未註冊的信箱，系統會自動幫對方建立帳號並開通權限。
        新成員只會看到自己的行程，以及被列為參與者的會議，不會看到你的私人日曆。
      </p>

      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(190px,auto)_auto]">
        <div className="min-w-0 space-y-1.5">
          <label className="text-xs font-medium" htmlFor="member-email">對方的電子郵件</label>
          <Input
            id="member-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="colleague@example.com"
            onKeyDown={(event) => event.key === "Enter" && void submit()}
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <label className="text-xs font-medium" htmlFor="member-role">角色</label>
          <select
            id="member-role"
            value={role}
            onChange={(event) => setRole(event.target.value as typeof role)}
            className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            <option value="member">一般成員</option>
            <option value="scheduler">排程管理者</option>
            <option value="admin">管理員</option>
          </select>
        </div>
        <Button size="sm" className="w-full shrink-0 gap-1.5 sm:w-auto" disabled={busy || !email.trim()} onClick={submit}>
          {busy ? <Spinner /> : <UserPlus className="h-4 w-4" aria-hidden />}
          加入工作區
        </Button>
      </div>

      {err && <p className="break-words text-sm text-destructive" role="alert">{err}</p>}
      {okMsg && <p className="break-words text-sm text-emerald-600 dark:text-emerald-400">{okMsg}</p>}

      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {rosterQ.isLoading ? (
          <li className="px-3 py-3 text-sm text-muted-foreground">載入中…</li>
        ) : members.length === 0 ? (
          <li className="px-3 py-3 text-sm text-muted-foreground">目前只有你一個人。</li>
        ) : (
          members.map((member) => (
            <MemberRow
              key={member.membership_id}
              member={member}
              isAdmin={me.role === "admin"}
              isMe={me.membership_id === member.membership_id}
              onInvalidate={() => qc.invalidateQueries({ queryKey: ["ws-members"] })}
            />
          ))
        )}
      </ul>
    </section>
  );
}

function MemberRow({
  member,
  isAdmin,
  isMe,
  onInvalidate,
}: {
  member: { membership_id: string; display_name: string; role: string; email?: string };
  isAdmin: boolean;
  isMe: boolean;
  onInvalidate: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleRoleChange = async (newRole: string) => {
    if (busy || newRole === member.role) return;
    if (!window.confirm(`確定要將 ${member.display_name} 的權限變更為 ${newRole} 嗎？`)) return;
    setBusy(true);
    try {
      await api.updateWorkspaceMemberRole(member.membership_id, newRole as any);
      onInvalidate();
    } catch (e: any) {
      alert(e.detail ?? "變更失敗");
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (busy) return;
    if (!window.confirm(`確定要將 ${member.display_name} 從工作區中移除嗎？這將會停用此帳號對此工作區的存取權。`)) return;
    setBusy(true);
    try {
      await api.removeWorkspaceMember(member.membership_id);
      onInvalidate();
    } catch (e: any) {
      alert(e.detail ?? "移除失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`flex min-h-11 min-w-0 items-center gap-3 px-3 py-2 text-sm ${busy ? "opacity-50 pointer-events-none" : ""}`}>
      <div className="min-w-0 flex-1 truncate font-medium" title={member.display_name}>
        {member.display_name}
        {member.email && <span className="text-muted-foreground ml-2 text-xs font-normal">{member.email}</span>}
        {isMe && <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">你</span>}
      </div>
      
      {isAdmin && !isMe ? (
        <select
          value={member.role}
          onChange={(e) => handleRoleChange(e.target.value)}
          className="h-7 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground focus-visible:outline-none"
        >
          <option value="member">一般成員</option>
          <option value="scheduler">排程管理者</option>
          <option value="admin">管理員</option>
        </select>
      ) : (
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-muted-foreground">{member.role}</span>
      )}

      {isAdmin && !isMe && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={handleRemove}
          title="移除成員"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      )}
    </li>
  );
}
