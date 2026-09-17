import { useEffect, useState } from "react";
import { useAuth } from "@/store/auth";
import { LoginPage } from "@/pages/LoginPage";
import { CalendarPage } from "@/pages/CalendarPage";
import { AgentsPage } from "@/pages/AgentsPage";
import { GroupsPage } from "@/pages/GroupsPage";
import { RsvpPage } from "@/pages/RsvpPage";
import { Spinner } from "@/components/ui/feedback";

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
  const { token, me, loading, bootstrap } = useAuth();
  const route = useHashRoute();

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

  if (!token || !me) return <LoginPage />;

  if (route.startsWith("#/settings/agents") && me.role === "admin") return <AgentsPage />;
  if (route.startsWith("#/groups")) return <GroupsPage />;
  return <CalendarPage />;
}
