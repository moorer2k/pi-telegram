/**
 * Optional live-tail consumer. One bounded, editable Telegram message per activity.
 * Delivery remains authorized and generation-fenced by the Activity API.
 */
import { registerTelegramActivityHandler, type TelegramActivityContext, type TelegramActivityEvent } from "./activity.ts";
import { createLiveTailProjection, renderLiveTail } from "./live-tail.ts";
import type { TelegramDeliveryHandle } from "./delivery.ts";

const EDIT_INTERVAL_MS = 1200;
const MAX_TRACKED_ACTIVITIES = 32;
const RETAIN_SETTLED_MS = 5000;

interface LiveTailState {
  projection: ReturnType<typeof createLiveTailProjection>;
  handle?: TelegramDeliveryHandle;
  lastText?: string;
  latest?: TelegramActivityContext;
  replyToMessageId?: number;
  timer?: ReturnType<typeof setTimeout>;
  cleanup?: ReturnType<typeof setTimeout>;
  pending: boolean;
  dirty: boolean;
  failed: boolean;
  settled: boolean;
  lastFlushStartedAt: number;
  retryNotBefore: number;
  hasContent: boolean;
  finalDelivered: boolean;
}

export function registerLiveTailConsumer(getSettings: () => TelegramLiveTailSettings = () => ({})) {
  const activities = new Map<string, LiveTailState>();
  let closed = false;

  function clearState(id: string): void {
    const state = activities.get(id);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    if (state.cleanup) clearTimeout(state.cleanup);
    activities.delete(id);
  }

  function schedule(id: string, delay: number): void {
    const state = activities.get(id);
    if (!state || closed || state.failed) return;
    delay = Math.max(delay, state.retryNotBefore - Date.now());
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void flush(id);
    }, delay);
  }

  async function flush(id: string): Promise<void> {
    const state = activities.get(id);
    if (!state || closed || state.pending || state.failed || !state.latest) return;
    state.pending = true;
    state.lastFlushStartedAt = Date.now();
    state.dirty = false;
    try {
      const settings = getSettings();
      const text = renderLiveTail(state.projection.getSnapshot(), settings);
      // Do not emit a status-only message for turns without visible activity.
      if (!state.hasContent || text === state.lastText) return;
      const view = { text, parseMode: "html" as const };
      const result = state.handle
        ? await state.latest.edit(state.handle, view)
        : await state.latest.send(view, { replyToMessageId: state.replyToMessageId });
      if (closed || activities.get(id) !== state) return;
      if (result.ok) {
        state.handle = result.value;
        state.lastText = text;
      } else if (result.reason === "rate-limited") {
        state.dirty = true;
        state.retryNotBefore = Date.now() + Math.max(EDIT_INTERVAL_MS, result.retryAfterMs ?? 3000);
        schedule(id, state.retryNotBefore - Date.now());
      } else {
        // No replacement sends on unknown ACK, stale authority, or invalid edits.
        state.failed = true;
      }
    } catch {
      state.failed = true;
    } finally {
      state.pending = false;
      if (state.dirty && !closed && !state.failed && !state.timer) {
        schedule(id, EDIT_INTERVAL_MS);
      }
      if (state.settled && !state.cleanup && !state.finalDelivered) {
        state.cleanup = setTimeout(() => clearState(id), RETAIN_SETTLED_MS);
      }
    }
  }

  const dispose = registerTelegramActivityHandler({
    id: "@llblab/pi-telegram/live-tail",
    handle(event: TelegramActivityEvent, ctx: TelegramActivityContext) {
      if (closed || event.source !== "telegram" || getSettings().enabled === false) return;
      let state = activities.get(event.activityId);
      if (!state) {
        if (event.type !== "agent-start") return;
        if (activities.size >= MAX_TRACKED_ACTIVITIES) {
          // Never evict an active message handle to start another send.
          return;
        }
        state = {
          projection: createLiveTailProjection(event.activityId),
          pending: false, dirty: false, failed: false, settled: false, lastFlushStartedAt: 0, retryNotBefore: 0, hasContent: false, finalDelivered: false,
          replyToMessageId: event.replyToMessageId,
        };
        activities.set(event.activityId, state);
      }
      if (!state.projection.accept(event)) return;
      state.latest = ctx;
      if ((event.type === "reasoning-delta" && event.delta.length > 0) ||
          (event.type === "reasoning-end" && event.text.length > 0) ||
          (event.type === "assistant-segment" && event.placement === "intermediate" && event.text.length > 0) ||
          event.type === "tool-start") state.hasContent = true;
      if (event.type === "agent-settled") {
        state.settled = true;
        if (!state.hasContent) { clearState(event.activityId); return; }
      }
      if (state.pending) {
        state.dirty = true;
      } else {
        // Throttle rather than debounce: continuous token deltas must not postpone updates forever.
        if (!state.timer || state.settled) {
          const interval = (getSettings().interval ?? 2) * 1000;
          const elapsed = Date.now() - state.lastFlushStartedAt;
          schedule(event.activityId, state.settled ? 0 : Math.max(0, interval - elapsed));
        }
      }
    },
  });

  const disposeConsumer = () => {
    closed = true;
    dispose();
    for (const id of activities.keys()) clearState(id);
  };
  const onFinalDelivered = (chatId: number, replyToMessageId: number | undefined) => {
    if (closed) return;
    for (const [id, state] of activities) {
      const target = state.latest?.defaultScope;
      if (target?.kind !== "target" || target.target.chatId !== chatId ||
          state.replyToMessageId !== replyToMessageId || state.finalDelivered) continue;
      state.finalDelivered = true;
      const delay: Record<string, number | undefined> = {
        keep: undefined, immediate: 0, "5s": 5000, "15s": 15000,
        "30s": 30000, "60s": 60000,
      };
      const ms = delay[getSettings().autoDelete ?? "keep"];
      if (ms === undefined) continue;
      if (state.cleanup) clearTimeout(state.cleanup);
      state.cleanup = setTimeout(() => {
        // Delete only the activity handle, never the separately delivered final answer.
        if (closed || activities.get(id) !== state || !state.handle || !state.latest) return;
        void state.latest.delete(state.handle).catch(() => {});
        clearState(id);
      }, ms);
    }
  };
  return { dispose: disposeConsumer, onFinalDelivered };
}
