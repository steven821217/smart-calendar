import { useState, type FormEvent } from "react";
import { Calendar } from "lucide-react";
import { useAuth } from "@/store/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Spinner } from "@/components/ui/feedback";
import { ApiError, type WorkspaceChoice } from "@/lib/api";

type Mode = "login" | "register";

/**
 * 登入 / 註冊頁（9.1）。
 *  - 登入：email + 密碼（後端 scrypt 驗證；失敗訊息不區分帳號是否存在）。
 *  - 註冊：建立一個新的 workspace，註冊者即該 workspace 的 admin，完成後自動登入。
 */
export function LoginPage() {
  const login = useAuth((s) => s.login);
  const register = useAuth((s) => s.register);
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 該帳號屬於多個工作區時，後端不發 token，先讓使用者選一個。 */
  const [choices, setChoices] = useState<WorkspaceChoice[] | null>(null);

  const isRegister = mode === "register";

  const switchMode = (next: Mode) => {
    setMode(next);
    setErr(null);
    setChoices(null);
    setPassword("");
    setPassword2("");
    // 切換登入／註冊時一律清空，不預填任何帳號
    setEmail("");
  };

  const failureMessage = (e: unknown) => {
    if (e instanceof ApiError) {
      return e.status === 401
        ? "電子郵件或密碼不正確。"
        : e.status === 422
          ? (e.detail ?? "請檢查輸入內容。")
          : (e.detail ?? (isRegister ? "註冊失敗，請稍後再試。" : "登入失敗，請稍後再試。"));
    }
    return isRegister ? "註冊失敗，請稍後再試。" : "登入失敗，請稍後再試。";
  };

  /** 選定工作區後，用同一組帳密再登入一次（帶 workspace_id）。 */
  const pickWorkspace = async (workspaceId: string) => {
    setBusy(true);
    setErr(null);
    try {
      await login(email, password, workspaceId);
    } catch (e) {
      setErr(failureMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (isRegister) {
      if (password.length < 8) return setErr("密碼至少 8 個字元。");
      if (password !== password2) return setErr("兩次輸入的密碼不一致。");
    }
    setBusy(true);
    try {
      if (isRegister) {
        await register({
          email,
          password,
          display_name: displayName.trim(),
          workspace_name: workspaceName.trim(),
        });
      } else {
        const r = await login(email, password);
        if (r.kind === "choose") setChoices(r.workspaces);
      }
    } catch (e) {
      setErr(failureMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // 多工作區選擇畫面
  if (choices) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <Calendar className="h-6 w-6" aria-hidden />
            <h1 className="text-lg font-semibold tracking-tight">選擇工作區</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            你的帳號（{email}）屬於多個工作區，請選擇要進入哪一個。之後可在左下角切換。
          </p>
          <ul className="space-y-2">
            {choices.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => pickWorkspace(w.id)}
                  className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                >
                  <span className="font-medium">{w.name}</span>
                  <span className="text-xs capitalize text-muted-foreground">{w.role}</span>
                </button>
              </li>
            ))}
          </ul>
          {err && (
            <p className="text-sm text-destructive" role="alert">
              {err}
            </p>
          )}
          <Button variant="outline" className="w-full" disabled={busy} onClick={() => setChoices(null)}>
            {busy && <Spinner />}
            返回
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-card p-6 shadow-sm"
      >
        <div className="flex items-center gap-2">
          <Calendar className="h-6 w-6" aria-hidden />
          <h1 className="text-lg font-semibold tracking-tight">智慧日曆</h1>
        </div>

        {/* 模式切換 */}
        <div className="flex rounded-md border border-border p-0.5 text-sm" role="tablist">
          {(["login", "register"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => switchMode(m)}
              className={
                "flex-1 rounded px-3 py-1.5 " +
                (mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")
              }
            >
              {m === "login" ? "登入" : "註冊"}
            </button>
          ))}
        </div>

        {isRegister && (
          <>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="display-name">
                你的名字
              </label>
              <Input
                id="display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="王小明"
                autoComplete="name"
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="workspace-name">
                工作區名稱
              </label>
              <Input
                id="workspace-name"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="例如 小明的團隊"
                required
              />
              <p className="text-xs text-muted-foreground">
                註冊會建立一個新的工作區，你是它的管理者。
              </p>
            </div>
          </>
        )}

        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="email">
            電子郵件
          </label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="password">
            密碼
          </label>
          <PasswordInput
            id="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isRegister ? "new-password" : "current-password"}
            required
          />
          {isRegister && <p className="text-xs text-muted-foreground">至少 8 個字元。</p>}
        </div>

        {isRegister && (
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="password2">
              再次輸入密碼
            </label>
            <PasswordInput
              id="password2"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
        )}

        {err && (
          <p className="text-sm text-destructive" role="alert">
            {err}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Spinner />}
          {isRegister ? "建立帳號" : "登入"}
        </Button>
      </form>
    </div>
  );
}
