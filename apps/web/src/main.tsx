import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { App } from "./App";
import { initTheme } from "./store/theme";
// Inter 自託管（variable 版，涵蓋 400/500/600 等字重）：由 Vite 打包 woff2，不打 Google Fonts CDN
import "@fontsource-variable/inter";
import "./styles/globals.css";

initTheme(); // 於掛載前套用主題，避免 FOUC

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      {/* Toast live region（sonner 內建 aria-live）；richColors 提供 success/error 語意色 */}
      <Toaster position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  </StrictMode>,
);
