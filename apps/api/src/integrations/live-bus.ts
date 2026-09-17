import { EventEmitter } from "node:events";
import type { WebhookEventType } from "./webhooks.js";

/**
 * 進程內即時事件匯流排（SSE 用）。
 *
 * `publishEvent`（webhooks.ts）在把事件排進 webhook 佇列的同時，也 emit 到此 bus，
 * 讓連著的瀏覽器（EventSource）即時收到，取代「輪詢等 20 秒」。
 *
 * 範圍：單一 API 進程內廣播，SSE 端依 workspace 過濾（ISO-3：跨 workspace 事件永不外洩）。
 * ⚠️ 多實例水平擴展時，需改用 Redis pub/sub 讓所有實例都收到；目前 dev/單進程足夠。
 */

export interface LiveEvent {
  workspaceId: string;
  type: WebhookEventType;
  payload: Record<string, unknown>;
  at: string; // ISO
}

class LiveBus extends EventEmitter {
  emitLive(ev: LiveEvent) {
    this.emit("live", ev);
  }
  onLive(fn: (ev: LiveEvent) => void) {
    this.on("live", fn);
    return () => this.off("live", fn);
  }
}

// 單例：整個進程共用一條 bus。提高上限，避免大量 SSE 連線觸發 MaxListeners 警告。
export const liveBus = new LiveBus();
liveBus.setMaxListeners(1000);
