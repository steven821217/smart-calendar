import { useState } from "react";
import { KeyRound, Copy, Check, AlertTriangle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/store/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/feedback";

/** 可勾選的 scope（對齊後端 AgentScope）；唯讀預設勾、寫入類需明確加勾（最小授權）。 */
const SCOPES: Array<{ value: string; label: string; hint: string; write?: boolean }> = [
  { value: "availability.read", label: "查看空檔", hint: "找共同可用時段、查詢自己的行程" },
  { value: "event.read", label: "讀取行程", hint: "列出事件與細節" },
  { value: "event.write", label: "建立／修改事件", hint: "會實際寫入你的行事曆", write: true },
  { value: "resource.book", label: "預約資源", hint: "訂會議室、公務車等", write: true },
];

const TTL_OPTIONS = [7, 30, 90];

/**
 * 綁定外部 agent（貼 token 型）。
 *
 * 為什麼是這個方式：實際的 MCP client（Claude Code / OpenCode / OpenClaw…）是在設定檔
 * 填一組靜態 `Authorization: Bearer <token>`，不會實作 OAuth 導向或 device code 流程。
 * 所以由「已登入的本人」在此勾選 scope 並產生一組短期、可撤銷的 token，貼進 agent 設定。
 * agent 全程拿不到帳號密碼，且該 token 的權限上限就是本人。
 */
export function AgentBindCard({ onIssued }: { onIssued?: () => void }) {
  const me = useAuth((s) => s.me)!;
  const [agentId, setAgentId] = useState("");
  const [scope, setScope] = useState<string[]>(["availability.read", "event.read"]);
  const [ttlDays, setTtlDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ token: string; agentId: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState<"token" | "config" | null>(null);

  const toggle = (v: string) =>
    setScope((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]));

  const submit = async () => {
    const id = agentId.trim();
    if (!id || scope.length === 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.createAgentToken(id, scope, ttlDays);
      setIssued({ token: r.access_token, agentId: r.agent_id, expiresAt: r.expires_at });
      setAgentId("");
      onIssued?.();
    } catch (e) {
      setErr(e instanceof ApiError ? (e.detail ?? e.title) : "產生失敗");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, which: "token" | "config") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setErr("複製失敗，請手動選取複製");
    }
  };

  const configSnippet = issued
    ? JSON.stringify(
        {
          mcpServers: {
            "smart-calendar": {
              url: `${window.location.origin}/mcp`,
              headers: { Authorization: `Bearer ${issued.token}` },
            },
          },
        },
        null,
        2,
      )
    : "";

  if (issued) {
    return (
      <section className="space-y-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-emerald-600" aria-hidden />
          <h2 className="text-sm font-semibold">已產生「{issued.agentId}」的綁定 token</h2>
        </div>
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
          <p>
            這組 token <strong>只會顯示這一次</strong>，請立刻複製並妥善保存；它等同於你的身分（
            {me.email}）在授權範圍內操作日曆。到期時間：
            {new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short", timeZone: me.timezone }).format(new Date(issued.expiresAt))}
            。若不小心外流，請到下方列表「撤銷」，即時失效。
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Token</label>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md border border-border bg-background px-2 py-1.5 text-xs">
              {issued.token}
            </code>
            <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={() => copy(issued.token, "token")}>
              {copied === "token" ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
              複製
            </Button>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">MCP client 設定（可直接貼上）</label>
          <div className="flex items-start gap-2">
            <pre className="flex-1 overflow-x-auto rounded-md border border-border bg-background p-2 text-xs">{configSnippet}</pre>
            <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={() => copy(configSnippet, "config")}>
              {copied === "config" ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
              複製
            </Button>
          </div>
        </div>

        {err && <p className="text-xs text-destructive">{err}</p>}
        <Button size="sm" variant="outline" onClick={() => setIssued(null)}>
          完成
        </Button>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4" aria-hidden />
        <h2 className="text-sm font-semibold">綁定一個外部 AI agent</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        產生一組供 agent 使用的 token，貼進它的 MCP 設定即可。agent 會以 <strong>{me.email}</strong>
        （{me.role}）的身分、在你勾選的範圍內操作日曆——不會拿到你的密碼，也不能超出你自己的權限。
        改期／取消等破壞性動作一律不開放給外部 agent。
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="agent-id">
            Agent 名稱
          </label>
          <Input
            id="agent-id"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder="例如 claude-desktop"
          />
          <p className="text-xs text-muted-foreground">用來在下方列表辨識與撤銷。</p>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="ttl">
            有效期限
          </label>
          <select
            id="ttl"
            value={ttlDays}
            onChange={(e) => setTtlDays(Number(e.target.value))}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {TTL_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {d} 天
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium">授權範圍（最小授權：只勾必要的）</legend>
        {SCOPES.map((s) => (
          <label key={s.value} className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={scope.includes(s.value)}
              onChange={() => toggle(s.value)}
              className="mt-0.5"
            />
            <span>
              <span className={s.write ? "font-medium text-amber-600" : "font-medium"}>
                {s.label}
                {s.write && "（寫入）"}
              </span>
              <span className="text-muted-foreground"> — {s.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {err && <p className="text-xs text-destructive">{err}</p>}

      <Button size="sm" disabled={busy || !agentId.trim() || scope.length === 0} onClick={submit}>
        {busy && <Spinner />}
        產生綁定 token
      </Button>
    </section>
  );
}
