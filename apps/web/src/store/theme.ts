import { create } from "zustand";

type Theme = "light" | "dark" | "system";
const KEY = "scal.theme";

function systemPrefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** 依 theme 套用 <html> class（class 策略，無 FOUC 由 initTheme 於載入時先套）。 */
function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", !dark);
}

interface ThemeState {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

export const useTheme = create<ThemeState>((set) => ({
  theme: (localStorage.getItem(KEY) as Theme) ?? "system",
  setTheme: (t: Theme) => {
    localStorage.setItem(KEY, t);
    apply(t);
    set({ theme: t });
  },
}));

/** 於 App 掛載前呼叫，避免 FOUC；並監聽系統主題變化。 */
export function initTheme() {
  const t = (localStorage.getItem(KEY) as Theme) ?? "system";
  apply(t);
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (((localStorage.getItem(KEY) as Theme) ?? "system") === "system") apply("system");
  });
}
