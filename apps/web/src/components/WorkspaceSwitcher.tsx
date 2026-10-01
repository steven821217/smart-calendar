import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/store/auth";
import { Spinner } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";

/**
 * 工作區切換器 ＋ 建立新工作區。
 *
 * 同一個帳號可以有多個工作區（自己建立的，或被別的 leader 加入的），彼此資料以 RLS
 * 完全隔離。用途例如「公司」與「家庭」分開管理。
 *
 * 切換是向後端 POST /v1/auth/switch-workspace 重新換一張 token——伺服器會核對
 * 該 membership 確實屬於本人。workspace 仍只能來自伺服器簽的 token（ISO-3），
 * 前端無法自行改成別的 workspace。
 *
 * 下拉選單只在「屬於多個工作區」時才出現（只有一個時沒得選），但「建立工作區」
 * 一律顯示——否則第一個額外工作區永遠沒有入口可以建。
 */
export function WorkspaceSwitcher() {
  const me = useAuth((s) => s.me);
  const switchWorkspace = useAuth((s) => s.switchWorkspace);
  const createWorkspace = useAuth((s) => s.createWorkspace);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const { data } = useQuery({
    queryKey: ["my-workspaces", me?.membership_id],
    queryFn: () => api.listMyWorkspaces(),
    enabled: !!me,
    staleTime: 60_000,
  });

  const workspaces = data?.workspaces ?? [];
  if (!me) return null;

  const message = (e: unknown) => (e instanceof ApiError ? (e.detail ?? e.title) : "操作失敗");

  const onChange = async (id: string) => {
    if (!id || id === me.workspace.id || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await switchWorkspace(id);
      // 換了 workspace＝換了整份資料脈絡，全部快取失效
      await qc.invalidateQueries();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await createWorkspace(name);
      // 後端回應已是新工作區的 token，等同建立後直接切過去
      await qc.invalidateQueries();
      setCreating(false);
      setNewName("");
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-2 space-y-1">
      <label className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground" htmlFor="ws-switch">
        <Building2 className="h-3 w-3" aria-hidden />
        工作區
      </label>

      {workspaces.length > 1 && (
        <div className="flex items-center gap-1.5">
          <select
            id="ws-switch"
            value={me.workspace.id}
            disabled={busy}
            onChange={(e) => void onChange(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}（{w.role}）
              </option>
            ))}
          </select>
          {busy && <Spinner />}
        </div>
      )}

      {creating ? (
        <div className="space-y-1.5">
          <Input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onCreate();
              if (e.key === "Escape") setCreating(false);
            }}
            placeholder="例如 家庭"
            aria-label="新工作區名稱"
            className="h-8 text-xs"
          />
          <div className="flex gap-1.5">
            <Button size="sm" className="h-7 flex-1 text-xs" disabled={busy || !newName.trim()} onClick={() => void onCreate()}>
              {busy ? <Spinner /> : "建立並切換"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 bg-background text-xs"
              disabled={busy}
              onClick={() => {
                setCreating(false);
                setNewName("");
                setErr(null);
              }}
              aria-label="取消建立工作區"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-full justify-start gap-1.5 bg-background text-xs"
          disabled={busy}
          onClick={() => setCreating(true)}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          建立工作區
        </Button>
      )}

      {err && <p className="px-1 text-xs text-destructive">{err}</p>}
    </div>
  );
}
