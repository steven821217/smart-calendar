import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiBase, getToken } from "@/lib/api";
import { useAuth } from "@/store/auth";

type LiveStatus = "connecting" | "open" | "closed";

/**
 * 即時推播（SSE）：連 /v1/events/stream，收到後端 emit 的生命週期事件就
 * invalidate 對應 query，讓收件匣 / 最近事件 / 月曆「即時」反映，不必等輪詢。
 *
 * 輪詢（refetchInterval）保留為離線／SSE 斷線時的備援。
 * EventSource 斷線會自動重連；token 變動（切帳號）時重建連線。
 */
export function useLiveEvents(): LiveStatus {
  const qc = useQueryClient();
  const me = useAuth((s) => s.me);
  const token = useAuth((s) => s.token);
  const [status, setStatus] = useState<LiveStatus>("closed");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!me || !token) {
      setStatus("closed");
      return;
    }
    const url = `${apiBase()}/v1/events/stream?access_token=${encodeURIComponent(getToken() ?? "")}`;
    setStatus("connecting");
    const es = new EventSource(url);
    esRef.current = es;

    const invalidate = () => {
      qc.invalidateQueries({ queryKey: ["pending-rsvps"] });
      qc.invalidateQueries({ queryKey: ["recent-events"] });
      qc.invalidateQueries({ queryKey: ["occurrences"] });
    };

    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus("connecting"); // 瀏覽器會自動重連
    // 依事件型別（後端以 `event: <type>` 標記）觸發重取
    for (const t of [
      "scheduling.rsvp_pending",
      "event.created",
      "event.updated",
      "event.deleted",
      "resource.booked",
    ]) {
      es.addEventListener(t, invalidate);
    }
    // 後端若以未具名 message 發送也一併處理
    es.onmessage = invalidate;

    return () => {
      es.close();
      esRef.current = null;
      setStatus("closed");
    };
  }, [me?.workspace.id, token, qc]);

  return status;
}
