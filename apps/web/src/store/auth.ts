import { create } from "zustand";
import { api, setToken, type Me, type WorkspaceChoice } from "@/lib/api";

const TOKEN_KEY = "scal.token";

interface AuthState {
  token: string | null;
  me: Me | null;
  loading: boolean;
  /**
   * 登入。回 'ok' = 已取得 token；回工作區清單 = 該帳號屬於多個工作區，
   * 需再帶 workspaceId 呼叫一次（後端在未指定時刻意不發 token）。
   */
  login: (email: string, password: string, workspaceId?: string) => Promise<
    { kind: "ok" } | { kind: "choose"; workspaces: WorkspaceChoice[] }
  >;
  /** 切換到同一個人的另一個工作區（token 由伺服器重簽）。 */
  switchWorkspace: (workspaceId: string) => Promise<void>;
  /** 在同一個帳號下再建立一個工作區，建立後直接切換過去。 */
  createWorkspace: (name: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    display_name: string;
    workspace_name: string;
  }) => Promise<void>;
  logout: () => void;
  bootstrap: () => Promise<void>;
}

/** 認證狀態（client state = Zustand，frontend.md §1）。token 存 localStorage（dev）。 */
export const useAuth = create<AuthState>((set) => ({
  token: null,
  me: null,
  loading: true,

  login: async (email: string, password: string, workspaceId?: string) => {
    const r = await api.login(email, password, workspaceId);
    if ("needs_workspace_selection" in r) {
      return { kind: "choose" as const, workspaces: r.workspaces };
    }
    setToken(r.access_token);
    localStorage.setItem(TOKEN_KEY, r.access_token);
    set({ token: r.access_token, me: r.me });
    return { kind: "ok" as const };
  },

  switchWorkspace: async (workspaceId: string) => {
    const r = await api.switchWorkspace(workspaceId);
    setToken(r.access_token);
    localStorage.setItem(TOKEN_KEY, r.access_token);
    set({ token: r.access_token, me: r.me });
  },

  createWorkspace: async (name: string) => {
    // 帶瀏覽器時區，讓新工作區的行程時間一開始就顯示正確
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const r = await api.createWorkspace(name, timezone);
    setToken(r.access_token);
    localStorage.setItem(TOKEN_KEY, r.access_token);
    set({ token: r.access_token, me: r.me });
  },

  register: async (input) => {
    // 帶瀏覽器時區，讓新帳號的行程時間一開始就顯示正確
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const r = await api.register({ ...input, timezone });
    setToken(r.access_token);
    localStorage.setItem(TOKEN_KEY, r.access_token);
    set({ token: r.access_token, me: r.me });
  },

  logout: () => {
    setToken(null);
    localStorage.removeItem(TOKEN_KEY);
    set({ token: null, me: null });
  },

  // 重新整理後：從 localStorage 還原 token 並向 /me 驗證。
  bootstrap: async () => {
    const t = localStorage.getItem(TOKEN_KEY);
    if (!t) {
      set({ loading: false });
      return;
    }
    setToken(t);
    try {
      const me = await api.me();
      set({ token: t, me, loading: false });
    } catch {
      // token 失效 → 清除
      setToken(null);
      localStorage.removeItem(TOKEN_KEY);
      set({ token: null, me: null, loading: false });
    }
  },
}));
