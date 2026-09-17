import type { ReactNode } from "react";
import { Calendar, Bot, LogOut, Sun, Moon, Monitor, Users } from "lucide-react";
import { useAuth } from "@/store/auth";
import { useTheme } from "@/store/theme";
import { Button } from "@/components/ui/button";
import { PendingInbox } from "@/components/PendingInbox";
import { RecentEvents } from "@/components/RecentEvents";
import { AgentChatDrawer } from "@/components/AgentChatDrawer";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { cn } from "@/lib/utils";
import { useState } from "react";

/** AppShell：側欄 + 頂欄 + workspace 唯讀標示（UI-3）。 */
export function AppShell({ children, topbar }: { children: ReactNode; topbar?: ReactNode }) {
  const { me, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const live = useLiveEvents(); // SSE 即時推播（取代輪詢延遲）
  const [agentOpen, setAgentOpen] = useState(false);

  const cycleTheme = () => setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light");
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-56 flex-col border-r border-border">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Calendar className="h-5 w-5" aria-hidden />
          <span className="font-semibold tracking-tight">智慧日曆</span>
        </div>
        <nav className="space-y-1 p-2 text-sm">
          <a
            href="#/calendar"
            className={cn("flex items-center gap-2 rounded-md px-3 py-2 hover:bg-accent")}
          >
            <Calendar className="h-4 w-4" aria-hidden />
            日曆
          </a>
          {(me?.role === "admin" || me?.role === "scheduler") && (
            <a
              href="#/groups"
              className="flex items-center gap-2 rounded-md px-3 py-2 text-muted-foreground hover:bg-accent"
            >
              <Users className="h-4 w-4" aria-hidden />
              團隊群組
            </a>
          )}
          {me?.role === "admin" && (
            <a
              href="#/settings/agents"
              className="flex items-center gap-2 rounded-md px-3 py-2 text-muted-foreground hover:bg-accent"
            >
              <Bot className="h-4 w-4" aria-hidden />
              Agent 管理
            </a>
          )}
        </nav>

        {/* 最近事件（前後 7 天）：讓使用者一眼看到近期有什麼事，佔剩餘空間可捲動 */}
        <div className="flex-1 overflow-hidden">
          <RecentEvents />
        </div>
        {/* 帳號區：workspace 唯讀（不能於 UI 切換 workspace，ISO-3）＋ 登出。
            登出後回登入頁即可改用其他帳號（如 member）登入。 */}
        <div className="border-t border-border px-3 py-3">
          <div className="px-1 pb-2 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">{me?.workspace.name}</div>
            <div className="truncate">{me?.email}</div>
            <div className="mt-0.5 capitalize">{me?.role}</div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={logout}
            aria-label="登出並切換帳號"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            登出／切換帳號
          </Button>
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-border px-4 py-2">
          <div className="flex items-center gap-3">{topbar}</div>
          <div className="flex items-center gap-1">
            <span
              className="mr-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
              title={live === "open" ? "即時推播已連線（SSE）" : "即時推播連線中…"}
              aria-label={`即時推播：${live}`}
            >
              <span
                className={cn(
                  "inline-block h-2 w-2 rounded-full",
                  live === "open" ? "bg-emerald-500" : "bg-amber-400 animate-pulse",
                )}
              />
              即時
            </span>
            <PendingInbox />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setAgentOpen(true)}
              aria-label="開啟日曆助理"
              title="日曆助理（問行程 / 排會）"
            >
              <Bot className="h-4 w-4 text-violet-500" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" onClick={cycleTheme} aria-label={`主題：${theme}`}>
              <ThemeIcon className="h-4 w-4" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" onClick={logout} aria-label="登出">
              <LogOut className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </header>
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>

      <AgentChatDrawer open={agentOpen} onClose={() => setAgentOpen(false)} />
    </div>
  );
}
