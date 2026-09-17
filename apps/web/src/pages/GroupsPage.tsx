import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Trash2, Plus, UserPlus, Crown } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Skeleton } from "@/components/ui/feedback";
import { useAuth } from "@/store/auth";
import { useMutationWithFeedback } from "@/lib/useMutationWithFeedback";
import { api, ApiError, type Group } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * 團隊群組管理（feature-team-groups Req 1）。
 * scheduler/admin 可建立/刪除群組、增減成員（含 leader/member 角色）。
 * Leader 之後可讓 Agent 幫「我的團隊」排會 → 產生 pending 邀請（見委員會/RSVP）。
 */
export function GroupsPage() {
  const me = useAuth((s) => s.me)!;
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const [selected, setSelected] = useState<Group | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Group | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const canManage = me.role === "admin" || me.role === "scheduler";

  const groupsQ = useQuery({ queryKey: ["groups", me.workspace.id], queryFn: () => api.listGroups() });
  const membersQ = useQuery({
    queryKey: ["group-members", selected?.id],
    queryFn: () => api.listGroupMembers(selected!.id),
    enabled: !!selected,
  });
  const rosterQ = useQuery({
    queryKey: ["ws-members", me.workspace.id],
    queryFn: () => api.listWorkspaceMembers(),
    enabled: !!selected,
  });

  const onErr = (e: unknown) => setErr(e instanceof ApiError ? (e.detail ?? e.title) : "操作失敗");

  const createMut = useMutationWithFeedback({
    successMessage: "已建立群組",
    mutation: {
      mutationFn: (name: string) => api.createGroup(name),
      onSuccess: () => {
        setNewName("");
        setErr(null);
        qc.invalidateQueries({ queryKey: ["groups"] });
      },
      onError: onErr,
    },
  });
  const deleteMut = useMutationWithFeedback({
    successMessage: "已刪除群組",
    mutation: {
      mutationFn: (id: string) => api.deleteGroup(id),
      onSuccess: (_r, id) => {
        if (selected?.id === id) setSelected(null);
        setConfirmDelete(null);
        qc.invalidateQueries({ queryKey: ["groups"] });
      },
      onError: onErr,
    },
  });
  const addMut = useMutationWithFeedback({
    successMessage: "已加入成員",
    mutation: {
      mutationFn: (v: { userId: string; role: "leader" | "member" }) =>
        api.addGroupMember(selected!.id, v.userId, v.role),
      onSuccess: () => qc.invalidateQueries({ queryKey: ["group-members", selected?.id] }),
      onError: onErr,
    },
  });
  const removeMut = useMutationWithFeedback({
    successMessage: "已移除成員",
    mutation: {
      mutationFn: (userId: string) => api.removeGroupMember(selected!.id, userId),
      onSuccess: () => qc.invalidateQueries({ queryKey: ["group-members", selected?.id] }),
      onError: onErr,
    },
  });

  const groups = groupsQ.data?.groups ?? [];
  const members = membersQ.data?.members ?? [];
  const memberUserIds = new Set(members.map((m) => m.user_id));
  const roster = (rosterQ.data?.members ?? []).filter((r) => !memberUserIds.has(r.user_id));

  return (
    <AppShell
      topbar={
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4" aria-hidden />
          <span className="text-sm font-medium">團隊群組</span>
        </div>
      }
    >
      <div className="h-full overflow-auto p-6">
        <div className="mx-auto grid max-w-5xl grid-cols-1 gap-6 md:grid-cols-[320px_1fr]">
          {/* 左：群組清單 + 建立 */}
          <div className="space-y-3">
            {err && (
              <div className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <span>{err}</span>
                <button onClick={() => setErr(null)} className="text-xs underline">關閉</button>
              </div>
            )}
            {canManage && (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newName.trim()) createMut.mutate(newName.trim());
                }}
              >
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="新群組名稱"
                  aria-label="新群組名稱"
                />
                <Button type="submit" disabled={createMut.isPending || !newName.trim()}>
                  <Plus className="h-4 w-4" aria-hidden />
                  建立
                </Button>
              </form>
            )}
            <p className="rounded-md bg-violet-500/10 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground ring-1 ring-inset ring-violet-500/20">
              ✨ 設好團隊後，可請 AI 助理「幫我的團隊借車去場勘」之類的指令排會，
              成員會自動收到待回覆邀請（見右上鈴鐺／通知信件）。
            </p>
            <div className="overflow-hidden rounded-lg border border-border">
              {groupsQ.isLoading ? (
                <div className="space-y-2 p-3">
                  {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-8" />)}
                </div>
              ) : groups.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">尚無群組。</div>
              ) : (
                <ul className="divide-y divide-border">
                  {groups.map((g) => (
                    <li
                      key={g.id}
                      className={cn(
                        "flex items-center justify-between px-3 py-2 text-sm hover:bg-accent/30",
                        selected?.id === g.id && "bg-accent/50",
                      )}
                    >
                      <button className="flex-1 text-left font-medium" onClick={() => setSelected(g)}>
                        {g.name}
                      </button>
                      {canManage && (
                        <button
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`刪除 ${g.name}`}
                          onClick={() => setConfirmDelete(g)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* 右：所選群組成員 */}
          <div className="space-y-3">
            {!selected ? (
              <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                選一個群組以管理成員
              </div>
            ) : (
              <>
                <h2 className="text-sm font-semibold">{selected.name} 的成員</h2>
                <div className="overflow-hidden rounded-lg border border-border">
                  {membersQ.isLoading ? (
                    <div className="space-y-2 p-3">
                      {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-8" />)}
                    </div>
                  ) : members.length === 0 ? (
                    <div className="p-6 text-center text-sm text-muted-foreground">此群組尚無成員。</div>
                  ) : (
                    <ul className="divide-y divide-border">
                      {members.map((m) => (
                        <li key={m.id} className="flex items-center justify-between px-3 py-2 text-sm">
                          <span className="flex items-center gap-2">
                            {m.role === "leader" && <Crown className="h-3.5 w-3.5 text-amber-500" aria-label="leader" />}
                            {m.display_name ?? m.user_id}
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] capitalize">{m.role}</span>
                          </span>
                          {canManage && (
                            <button
                              className="text-muted-foreground hover:text-destructive"
                              aria-label={`移除 ${m.display_name ?? m.user_id}`}
                              onClick={() => removeMut.mutate(m.user_id)}
                            >
                              <Trash2 className="h-4 w-4" aria-hidden />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* 加成員 */}
                {canManage && roster.length > 0 && (
                  <div className="rounded-lg border border-border p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      <UserPlus className="h-3.5 w-3.5" aria-hidden />
                      加入成員
                    </div>
                    <ul className="space-y-1">
                      {roster.map((r) => (
                        <li key={r.user_id} className="flex items-center justify-between gap-2 text-sm">
                          <span>{r.display_name}</span>
                          <span className="flex gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={addMut.isPending}
                              onClick={() => addMut.mutate({ userId: r.user_id, role: "member" })}
                            >
                              加為 member
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={addMut.isPending}
                              onClick={() => addMut.mutate({ userId: r.user_id, role: "leader" })}
                            >
                              加為 leader
                            </Button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Agent 連結提示：呼應核心情境（Leader 設好團隊 → 請 AI 助理排會） */}
      {confirmDelete && (
        <ConfirmDialog
          title="刪除群組？"
          destructive
          confirmLabel="刪除"
          busy={deleteMut.isPending}
          body={
            <>
              將刪除群組 <strong>{confirmDelete.name}</strong> 及其成員關係。此動作無法復原，
              但不會刪除成員本身或既有事件。
            </>
          }
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => deleteMut.mutate(confirmDelete.id)}
        />
      )}
    </AppShell>
  );
}
