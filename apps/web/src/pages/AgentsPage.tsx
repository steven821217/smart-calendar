import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, ShieldOff, RotateCcw } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { AgentActivityDrawer } from "@/components/agents/AgentActivityDrawer";
import { AgentBindCard } from "@/components/agents/AgentBindCard";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { useAuth } from "@/store/auth";
import { useMutationWithFeedback } from "@/lib/useMutationWithFeedback";
import { api, ApiError, type AgentSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Agent & MCP 管理（9.9，UI-26/27）。經 agent.manage（admin）+ RLS，只見本 workspace。
 * 後端 API：GET /v1/agents、/v1/agents/:id/activity、DELETE /v1/agents/:id/authorization。
 */
export function AgentsPage() {
  const me = useAuth((s) => s.me)!;
  const qc = useQueryClient();
  const [drawerAgent, setDrawerAgent] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<AgentSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const isAdmin = me.role === "admin";
  const { data, isLoading } = useQuery({
    queryKey: ["agents", me.workspace.id],
    queryFn: () => api.listAgents(),
    // 列出全 workspace 的 agent 需 agent.manage（admin）；成員只用本頁綁定自己的 agent。
    enabled: isAdmin,
  });

  const revokeMut = useMutationWithFeedback({
    successMessage: "已撤銷 agent 授權",
    mutation: {
      mutationFn: (id: string) => api.revokeAgent(id),
      onSuccess: () => {
        setConfirmRevoke(null);
        setErr(null);
        qc.invalidateQueries({ queryKey: ["agents"] });
      },
      // 保留頁內錯誤橫幅（與 toast 並存）
      onError: (e: unknown) =>
        setErr(e instanceof ApiError ? (e.detail ?? e.title) : "撤銷失敗"),
    },
  });

  const fmt = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat("zh-TW", {
          dateStyle: "short",
          timeStyle: "short",
          timeZone: me.timezone,
        }).format(new Date(iso))
      : "—";

  const agents = data?.agents ?? [];

  return (
    <AppShell
      topbar={
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4" aria-hidden />
          <span className="text-sm font-medium">Agent & MCP 管理</span>
        </div>
      }
    >
      <div className="h-full overflow-auto p-6">
        <div className="mx-auto max-w-4xl space-y-4">
          <p className="text-sm text-muted-foreground">
            外部 AI 對本 workspace（{me.workspace.name}）的授權與 MCP 活動。撤銷即時生效（Redis 黑名單，MCP-8），
            不跨 workspace、不洩漏私密內容。
          </p>

          {err && (
            <div className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span>{err}</span>
              <button onClick={() => setErr(null)} className="text-xs underline" aria-label="關閉">
                關閉
              </button>
            </div>
          )}

          {/* 綁定自己的 agent：任何登入使用者皆可（token 權限上限＝本人） */}
          <AgentBindCard onIssued={() => qc.invalidateQueries({ queryKey: ["agents"] })} />

          {!isAdmin ? (
            <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              已授權 agent 的總覽與撤銷需要 admin 權限。若要停用你剛綁定的 agent，請聯絡 workspace 管理者。
            </p>
          ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Agent</th>
                  <th className="px-3 py-2 font-medium">Scopes</th>
                  <th className="px-3 py-2 font-medium">動作數</th>
                  <th className="px-3 py-2 font-medium">最後活動</th>
                  <th className="px-3 py-2 font-medium">狀態</th>
                  <th className="px-3 py-2 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array.from({ length: 3 }, (_, i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className="px-3 py-3" colSpan={6}>
                        <Skeleton className="h-5" />
                      </td>
                    </tr>
                  ))
                ) : agents.length === 0 ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-muted-foreground" colSpan={6}>
                      尚無 agent 對本 workspace 活動過。
                    </td>
                  </tr>
                ) : (
                  agents.map((a) => (
                    <tr key={a.agent_id} className="border-b border-border last:border-0 hover:bg-accent/30">
                      <td className="px-3 py-2">
                        <button
                          onClick={() => setDrawerAgent(a.agent_id)}
                          className="font-mono text-xs underline-offset-2 hover:underline"
                        >
                          {a.agent_id}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {a.scopes.length ? (
                            a.scopes.map((s) => (
                              <span key={s} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                                {s}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 tabular-nums">{a.actions}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{fmt(a.last_activity)}</td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium",
                            a.revoked
                              ? "bg-destructive/15 text-destructive"
                              : "bg-primary/10 text-foreground",
                          )}
                        >
                          {a.revoked ? "已撤銷" : "已授權"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {a.revoked ? (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                            撤銷 24h 後自動失效
                          </span>
                        ) : (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setConfirmRevoke(a)}
                          >
                            <ShieldOff className="h-3.5 w-3.5" aria-hidden />
                            撤銷
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          )}
        </div>
      </div>

      {drawerAgent && (
        <AgentActivityDrawer
          agentId={drawerAgent}
          tz={me.timezone}
          onClose={() => setDrawerAgent(null)}
        />
      )}

      {confirmRevoke && (
        <ConfirmDialog
          title="撤銷 agent 授權？"
          destructive
          confirmLabel="撤銷"
          busy={revokeMut.isPending}
          body={
            <>
              <span className="font-mono">{confirmRevoke.agent_id}</span>{" "}
              的授權將<strong>即時</strong>失效，其後續 MCP 呼叫會被拒絕（fail-closed）。此動作可於重新授權前保留 24 小時。
            </>
          }
          onCancel={() => setConfirmRevoke(null)}
          onConfirm={() => revokeMut.mutate(confirmRevoke.agent_id)}
        />
      )}
    </AppShell>
  );
}
