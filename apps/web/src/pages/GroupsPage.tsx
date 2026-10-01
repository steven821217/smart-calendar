import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Trash2, Plus, UserPlus, Crown, Sparkles } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { WorkspaceMembersCard } from "@/components/WorkspaceMembersCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Skeleton } from "@/components/ui/feedback";
import { useAuth } from "@/store/auth";
import { useMutationWithFeedback } from "@/lib/useMutationWithFeedback";
import { api, ApiError, type Group } from "@/lib/api";
import { cn } from "@/lib/utils";

/** 團隊群組管理：建立群組、配置 leader/member，供 AI 委派排程使用。 */
export function GroupsPage() {
  const me = useAuth((state) => state.me)!;
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

  const onErr = (error: unknown) => setErr(error instanceof ApiError ? (error.detail ?? error.title) : "操作失敗");

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
      onSuccess: (_result, id) => {
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
      mutationFn: (value: { userId: string; role: "leader" | "member" }) =>
        api.addGroupMember(selected!.id, value.userId, value.role),
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
  const memberUserIds = new Set(members.map((member) => member.user_id));
  const roster = (rosterQ.data?.members ?? []).filter((member) => !memberUserIds.has(member.user_id));

  return (
    <AppShell
      topbar={
        <div className="flex min-w-0 items-center gap-2">
          <Users className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate text-sm font-semibold">團隊群組</span>
        </div>
      }
    >
      <div className="h-full overflow-auto px-4 py-5 sm:p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          {me.role === "admin" && <WorkspaceMembersCard />}

          <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
            <section className="min-w-0 space-y-3" aria-labelledby="groups-heading">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h1 id="groups-heading" className="text-base font-semibold tracking-tight">群組</h1>
                  <p className="mt-0.5 text-xs text-muted-foreground">建立排程時可直接指定整個團隊</p>
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {groups.length} 組
                </span>
              </div>

              {err && (
                <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
                  <span className="min-w-0 flex-1 break-words">{err}</span>
                  <button type="button" onClick={() => setErr(null)} className="shrink-0 text-xs font-medium underline underline-offset-2">關閉</button>
                </div>
              )}

              {canManage && (
                <form
                  className="flex flex-col gap-2 sm:flex-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (newName.trim()) createMut.mutate(newName.trim());
                  }}
                >
                  <Input
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder="輸入新群組名稱"
                    aria-label="新群組名稱"
                    className="min-w-0 flex-1"
                  />
                  <Button type="submit" className="w-full shrink-0 sm:w-auto" disabled={createMut.isPending || !newName.trim()}>
                    <Plus className="h-4 w-4" aria-hidden />
                    建立群組
                  </Button>
                </form>
              )}

              <div className="flex items-start gap-2.5 rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" aria-hidden />
                <p>設好團隊後，可請 AI 助理幫團隊排會或安排場勘；成員會在收件匣收到待回覆邀請。</p>
              </div>

              <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                {groupsQ.isLoading ? (
                  <div className="space-y-2 p-3">
                    {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-10" />)}
                  </div>
                ) : groups.length === 0 ? (
                  <div className="p-8 text-center text-sm text-muted-foreground">尚無群組，先建立第一個團隊。</div>
                ) : (
                  <ul className="divide-y divide-border">
                    {groups.map((group) => (
                      <li
                        key={group.id}
                        className={cn(
                          "flex min-h-12 min-w-0 items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent/40",
                          selected?.id === group.id && "bg-accent/70",
                        )}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left font-medium"
                          title={group.name}
                          onClick={() => setSelected(group)}
                        >
                          {group.name}
                        </button>
                        {canManage && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                            aria-label={`刪除 ${group.name}`}
                            onClick={() => setConfirmDelete(group)}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <section className="min-w-0 space-y-3" aria-labelledby="members-heading">
              {!selected ? (
                <div className="flex min-h-52 items-center justify-center rounded-xl border border-dashed border-border bg-muted/10 px-4 text-center text-sm text-muted-foreground">
                  從群組清單選擇一個團隊以管理成員
                </div>
              ) : (
                <>
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h2 id="members-heading" className="truncate text-base font-semibold tracking-tight" title={selected.name}>
                        {selected.name}
                      </h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">群組成員與排程角色</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      {members.length} 人
                    </span>
                  </div>

                  <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                    {membersQ.isLoading ? (
                      <div className="space-y-2 p-3">
                        {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-10" />)}
                      </div>
                    ) : members.length === 0 ? (
                      <div className="p-8 text-center text-sm text-muted-foreground">此群組尚無成員。</div>
                    ) : (
                      <ul className="divide-y divide-border">
                        {members.map((member) => {
                          const name = member.display_name ?? member.user_id;
                          return (
                            <li key={member.id} className="flex min-h-12 min-w-0 items-center gap-2 px-3 py-2 text-sm">
                              <div className="flex min-w-0 flex-1 items-center gap-2">
                                {member.role === "leader" && <Crown className="h-4 w-4 shrink-0 text-amber-500" aria-label="群組負責人" />}
                                <span className="min-w-0 truncate font-medium" title={name}>{name}</span>
                                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-muted-foreground">
                                  {member.role}
                                </span>
                              </div>
                              {canManage && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                                  aria-label={`移除 ${name}`}
                                  onClick={() => removeMut.mutate(member.user_id)}
                                >
                                  <Trash2 className="h-4 w-4" aria-hidden />
                                </Button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>

                  {canManage && roster.length > 0 && (
                    <div className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
                      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                        <UserPlus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        加入工作區成員
                      </div>
                      <ul className="space-y-2">
                        {roster.map((person) => (
                          <li key={person.user_id} className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted/30 p-2.5 sm:flex-row sm:items-center sm:justify-between">
                            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={person.display_name}>{person.display_name}</span>
                            <div className="grid w-full shrink-0 grid-cols-2 gap-2 sm:w-auto">
                              <Button
                                size="sm"
                                variant="outline"
                                className="w-full whitespace-nowrap sm:w-auto"
                                disabled={addMut.isPending}
                                onClick={() => addMut.mutate({ userId: person.user_id, role: "member" })}
                              >
                                加為成員
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="w-full whitespace-nowrap sm:w-auto"
                                disabled={addMut.isPending}
                                onClick={() => addMut.mutate({ userId: person.user_id, role: "leader" })}
                              >
                                設為組長
                              </Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </div>
      </div>

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
