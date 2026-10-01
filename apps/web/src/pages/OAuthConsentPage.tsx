import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, AlertTriangle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/store/auth";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/feedback";
import { LoginPage } from "@/pages/LoginPage";

/** 可授權的 scope 與人話說明（與後端 AgentScope 對齊）。 */
const SCOPE_LABELS: Record<string, { label: string; write?: boolean }> = {
  "availability.read": { label: "查看你的空檔與行程" },
  "event.read": { label: "讀取你的事件內容" },
  "event.write": { label: "建立／修改你的事件", write: true },
  "resource.book": { label: "代你預約會議室、公務車等資源", write: true },
};

/**
 * OAuth 2.1 同意頁（自動發現流程的使用者可見步驟）。
 *
 * 流程：MCP client 導向 `GET /v1/oauth/authorize` → 後端驗參數後導到本頁 →
 * 使用者（必要時先登入）看清楚「哪個應用要什麼權限」→ 核准後呼叫
 * `POST /v1/oauth/consent` 取得授權碼 → 由瀏覽器帶 code+state 導回 client。
 *
 * 安全：redirect_uri 已在 /authorize 過白名單，且授權碼綁定該 redirect_uri；
 * state 原樣帶回（CSRF）。使用者可以按「拒絕」，此時以 access_denied 導回。
 */
export function OAuthConsentPage() {
  const me = useAuth((s) => s.me);
  const token = useAuth((s) => s.token);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // hash route 形如 #/oauth/consent?client_id=…&redirect_uri=…
  const params = useMemo(() => {
    const hash = window.location.hash;
    const qs = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
    return new URLSearchParams(qs);
  }, []);

  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const state = params.get("state") ?? "";
  const resource = params.get("resource") ?? "";
  const scopes = (params.get("scope") ?? "availability.read event.read").split(/\s+/).filter(Boolean);

  // 從授權伺服器 metadata 取「這次授權會維持多久」，避免在 UI 寫死天數。
  const [lifetimeDays, setLifetimeDays] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${window.location.origin}/.well-known/oauth-authorization-server`)
      .then((r) => r.json())
      .then((m) => {
        if (!cancelled && typeof m?.scal_access_token_lifetime_days === "number") {
          setLifetimeDays(m.scal_access_token_lifetime_days);
        }
      })
      .catch(() => {
        /* 取不到就不顯示天數，不影響授權 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 未登入 → 先顯示登入頁（登入後本頁會因狀態變更重新渲染，參數仍在 URL）
  if (!me || !token) return <LoginPage />;

  const missing = !clientId || !redirectUri || !codeChallenge;

  const back = (extra: Record<string, string>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    if (state) u.searchParams.set("state", state);
    window.location.replace(u.toString());
  };

  const approve = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.oauthConsent({
        agent_id: clientId,
        scope: scopes,
        code_challenge: codeChallenge,
        redirect_uri: redirectUri,
        client_id: clientId,
        ...(resource ? { resource } : {}),
      });
      back({ code: r.authorization_code });
    } catch (e) {
      setErr(e instanceof ApiError ? (e.detail ?? e.title) : "授權失敗，請重試。");
      setBusy(false);
    }
  };

  const deny = () => back({ error: "access_denied", error_description: "user denied the request" });

  if (missing) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md space-y-3 rounded-lg border border-destructive/40 bg-card p-6">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" aria-hidden />
            <h1 className="text-base font-semibold">授權請求不完整</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            缺少必要參數（client_id / redirect_uri / code_challenge）。請回到你的 AI 應用重新發起連線。
          </p>
        </div>
      </div>
    );
  }

  const hasWrite = scopes.some((s) => SCOPE_LABELS[s]?.write);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-5 rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-violet-500" aria-hidden />
          <h1 className="text-lg font-semibold tracking-tight">授權存取你的日曆</h1>
        </div>

        <p className="text-sm">
          <strong className="font-mono text-[13px]">{clientId}</strong> 想以你的身分（
          {me.email}）存取「{me.workspace.name}」的日曆。
        </p>

        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground">它將取得這些權限：</p>
          <ul className="space-y-1 text-sm">
            {scopes.map((s) => (
              <li key={s} className="flex items-start gap-2">
                <span className={SCOPE_LABELS[s]?.write ? "text-amber-600" : "text-foreground"}>•</span>
                <span>
                  {SCOPE_LABELS[s]?.label ?? s}
                  {SCOPE_LABELS[s]?.write && <span className="text-amber-600">（可寫入）</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          <p>• 它<strong>拿不到你的密碼</strong>，權限也不會超過你自己。</p>
          <p>• 改期／取消等破壞性動作一律不開放給外部應用。</p>
          <p>
            • 這次授權{lifetimeDays ? `約 ${lifetimeDays} 天後到期` : "會在一段時間後到期"}；
            你也可以隨時到「我的 AI agent」撤銷，<strong>立即失效</strong>。
          </p>
          {hasWrite && (
            <p className="text-amber-600">• 這次包含寫入權限，它可以在你的日曆建立或修改事件。</p>
          )}
          <p className="truncate">• 完成後將導回：{redirectUri}</p>
        </div>

        {err && (
          <p className="text-sm text-destructive" role="alert">
            {err}
          </p>
        )}

        <div className="flex gap-2">
          <Button className="flex-1" disabled={busy} onClick={approve}>
            {busy && <Spinner />}
            同意並繼續
          </Button>
          <Button variant="outline" className="flex-1" disabled={busy} onClick={deny}>
            拒絕
          </Button>
        </div>
      </div>
    </div>
  );
}
