import { create } from "zustand";
import { api, setToken, type Me } from "@/lib/api";

const TOKEN_KEY = "scal.token";

interface AuthState {
  token: string | null;
  me: Me | null;
  loading: boolean;
  login: (email: string) => Promise<void>;
  logout: () => void;
  bootstrap: () => Promise<void>;
}

/** 認證狀態（client state = Zustand，frontend.md §1）。token 存 localStorage（dev）。 */
export const useAuth = create<AuthState>((set) => ({
  token: null,
  me: null,
  loading: true,

  login: async (email: string) => {
    const r = await api.login(email);
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
