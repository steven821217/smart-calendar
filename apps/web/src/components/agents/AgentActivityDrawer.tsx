import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";

/** Agent 稽核活動 Drawer（右側抽屜）：列該 agent 的 MCP 動作，allow/deny 標色（UI-27）。 */
export function AgentActivityDrawer({
  agentId,
  tz,
  onClose,
}: {
  agentId: string;
  tz: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["agent-activity", agentId],
    queryFn: () => api.agentActivity(agentId),
  });

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat("zh-TW", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: tz,
    }).format(new Date(iso));

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${agentId} 稽核活動`}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Agent 稽核活動</h2>
            <p className="font-mono text-xs text-muted-foreground">{agentId}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="關閉">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : !data?.entries.length ? (
            <p className="text-sm text-muted-foreground">尚無稽核紀錄。</p>
          ) : (
            <ul className="space-y-2">
              {data.entries.map((e) => {
                const tool = (e.metadata?.tool as string) ?? "";
                return (
                  <li
                    key={e.id}
                    className="rounded-md border border-border p-3 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{e.action}</span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-xs font-medium",
                          e.decision === "allow"
                            ? "bg-primary/10 text-foreground"
                            : "bg-destructive/15 text-destructive",
                        )}
                      >
                        {e.decision ?? "—"}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      {tool && <span>tool: {tool}</span>}
                      {e.target_type && <span>resource: {e.target_type}</span>}
                      <span>{fmt(e.at)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
