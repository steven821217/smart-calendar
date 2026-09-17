import { useState, type FormEvent } from "react";
import { Calendar } from "lucide-react";
import { useAuth } from "@/store/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/feedback";
import { ApiError } from "@/lib/api";

/** 登入頁（9.1，dev：email 登入）。 */
export function LoginPage() {
  const login = useAuth((s) => s.login);
  const [email, setEmail] = useState("a@example.com");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(email);
    } catch (e) {
      setErr(e instanceof ApiError ? e.title : "登入失敗");
    } finally {
      setBusy(false);
    }
  };

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
            required
          />
          <p className="text-xs text-muted-foreground">開發示範：a@example.com / b@example.com</p>
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Spinner />}
          登入
        </Button>
      </form>
    </div>
  );
}
