import { useEffect, useState } from "react";
import { useAuth } from "@/store/auth";
import { LoginPage } from "@/pages/LoginPage";
import { CalendarPage } from "@/pages/CalendarPage";
import { AgentsPage } from "@/pages/AgentsPage";
import { GroupsPage } from "@/pages/GroupsPage";
import { RsvpPage } from "@/pages/RsvpPage";
import { OAuthConsentPage } from "@/pages/OAuthConsentPage";
import { Spinner } from "@/components/ui/feedback";
import { AUTH_EXPIRED_EVENT } from "@/lib/api";
import { toast } from "sonner";

/** 極簡 hash 路由（trunk）；日後可換 React Router。 */
function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash || "#/calendar");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/calendar");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const { token, me, loading, bootstrap, logout } = useAuth();
  const route = useHashRoute();

  useEffect(() => {
    const onAuthExpired = () => {
      logout();
      toast.error("登入已過期", { description: "為保護帳號安全，請重新登入後繼續。" });
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
  }, [logout]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  // RSVP：Member 憑通知連結中的 rsvp_token 回覆，免登入（token 自證身份）。
  if (route.startsWith("#/rsvp")) return <RsvpPage />;

  // OAuth 同意頁：自身處理「未登入先登入」，故在 token 檢查之前分流
  //（登入後參數仍在 hash 裡，可繼續完成授權）。
  if (route.startsWith("#/oauth/consent")) return <OAuthConsentPage />;

  if (!token || !me) return <LoginPage />;

  // Agent 頁：所有成員都可進來綁定自己的 agent；頁內再依角色決定是否顯示總覽/撤銷。
  if (route.startsWith("#/settings/agents")) return <AgentsPage />;
  if (route.startsWith("#/groups")) return <GroupsPage />;
  return <CalendarPage />;
}
