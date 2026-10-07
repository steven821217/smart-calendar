import type { ReactNode } from "react";
import { Calendar, Bot, LogOut, Sun, Moon, Monitor, Users, Menu, X } from "lucide-react";
import { useAuth } from "@/store/auth";
import { useTheme } from "@/store/theme";
import { Button } from "@/components/ui/button";
import { PendingInbox } from "@/components/PendingInbox";
import { RecentEvents } from "@/components/RecentEvents";
import { AgentChatDrawer } from "@/components/AgentChatDrawer";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { cn } from "@/lib/utils";
import { useState } from "react";

/** AppShell：一致的側欄、響應式頂欄與 workspace 識別（UI-3）。 */
export function AppShell({ children, topbar }: { children: ReactNode; topbar?: ReactNode }) {
  const { me, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const live = useLiveEvents();
  const [agentOpen, setAgentOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  const cycleTheme = () => setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light");
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const closeNav = () => setNavOpen(false);

  return (
    <div className="flex h-dvh min-w-0 bg-background text-foreground">
      {navOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-[2px] md:hidden"
          onClick={closeNav}
          aria-label="關閉導覽選單"
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-card shadow-xl transition-transform md:static md:z-auto md:w-60 md:translate-x-0 md:shadow-none",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-[#A61C4B] text-primary-foreground shadow-md ring-1 ring-primary/20">
            <Calendar className="h-4 w-4" aria-hidden />
          </span>
          <span className="font-semibold tracking-tight">智慧日曆</span>
          <Button variant="ghost" size="icon" className="ml-auto md:hidden" onClick={closeNav} aria-label="關閉選單">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <nav className="space-y-1 p-3 text-sm" aria-label="主要導覽">
          <a href="#/calendar" onClick={closeNav} className="flex h-9 items-center gap-2.5 rounded-md bg-accent px-3 font-medium text-accent-foreground shadow-sm transition-all hover:bg-accent/80 hover:translate-x-0.5">
            <Calendar className="h-4 w-4" aria-hidden />
            日曆
          </a>
          {(me?.role === "admin" || me?.role === "scheduler") && (
            <a href="#/groups" onClick={closeNav} className="flex h-9 items-center gap-2.5 rounded-md px-3 text-muted-foreground transition-all hover:bg-accent hover:text-accent-foreground hover:translate-x-0.5">
              <Users className="h-4 w-4" aria-hidden />
              團隊群組
            </a>
          )}
          <a href="#/settings/agents" onClick={closeNav} className="flex h-9 items-center gap-2.5 rounded-md px-3 text-muted-foreground transition-all hover:bg-accent hover:text-accent-foreground hover:translate-x-0.5">
            <Bot className="h-4 w-4" aria-hidden />
            {me?.role === "admin" ? "Agent 管理" : "我的 AI agent"}
          </a>
        </nav>

        <div className="min-h-0 flex-1 overflow-hidden">
          <RecentEvents />
        </div>
        <div className="border-t border-border bg-muted/20 px-3 py-3">
          <div className="px-1 pb-2 text-xs leading-5 text-muted-foreground">
            <div className="truncate font-medium text-foreground">{me?.workspace.name}</div>
            <div className="truncate">{me?.email}</div>
            <div className="capitalize">{me?.role}</div>
          </div>
          <WorkspaceSwitcher />
          <Button variant="outline" size="sm" className="w-full justify-start gap-2 bg-background" onClick={logout} aria-label="登出並切換帳號">
            <LogOut className="h-4 w-4" aria-hidden />
            登出／切換帳號
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 py-2 backdrop-blur md:px-4">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setNavOpen(true)} aria-label="開啟導覽選單">
            <Menu className="h-5 w-5" aria-hidden />
          </Button>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{topbar}</div>
          <div className="flex shrink-0 items-center gap-0.5">
            <span
              className="mr-1 hidden items-center gap-1.5 text-xs text-muted-foreground xl:inline-flex"
              title={live === "open" ? "即時推播已連線（SSE）" : "即時推播連線中…"}
              aria-label={`即時推播：${live}`}
            >
              <span className={cn("inline-block h-2 w-2 rounded-full", live === "open" ? "bg-emerald-500" : "animate-pulse bg-amber-400")} />
              即時
            </span>
            <PendingInbox />
            <Button variant="ghost" size="icon" onClick={() => setAgentOpen(true)} aria-label="開啟日曆助理" title="日曆助理（問行程 / 排會）">
              <Bot className="h-4 w-4 text-violet-500" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" onClick={cycleTheme} aria-label={`主題：${theme}`}>
              <ThemeIcon className="h-4 w-4" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" className="hidden sm:inline-flex" onClick={logout} aria-label="登出">
              <LogOut className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>

      <AgentChatDrawer open={agentOpen} onClose={() => setAgentOpen(false)} />
    </div>
  );
}
