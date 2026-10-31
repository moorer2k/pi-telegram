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
  timer?: ReturnType<typeof setTimeout>;
  cleanup?: ReturnType<typeof setTimeout>;
  pending: boolean;
  dirty: boolean;
  failed: boolean;
  settled: boolean;
  lastFlushStartedAt: number;
}

export function registerLiveTailConsumer() {
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
      const text = renderLiveTail(state.projection.getSnapshot());
      if (text === state.lastText || text === "<b>Status</b>\nWorking") return;
      const view = { text, parseMode: "html" as const };
      const result = state.handle
        ? await state.latest.edit(state.handle, view)
        : await state.latest.send(view);
      if (closed || activities.get(id) !== state) return;
      if (result.ok) {
        state.handle = result.value;
        state.lastText = text;
      } else if (result.reason === "rate-limited") {
        state.dirty = true;
        schedule(id, Math.max(EDIT_INTERVAL_MS, result.retryAfterMs ?? 3000));
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
      if (state.settled && !state.cleanup) {
        state.cleanup = setTimeout(() => clearState(id), RETAIN_SETTLED_MS);
      }
    }
  }

  const dispose = registerTelegramActivityHandler({
    id: "@llblab/pi-telegram/live-tail",
    handle(event: TelegramActivityEvent, ctx: TelegramActivityContext) {
      if (closed || event.source !== "telegram") return;
      let state = activities.get(event.activityId);
      if (!state) {
        if (event.type !== "agent-start") return;
        if (activities.size >= MAX_TRACKED_ACTIVITIES) {
          // Never evict an active message handle to start another send.
          return;
        }
        state = {
          projection: createLiveTailProjection(event.activityId),
          pending: false, dirty: false, failed: false, settled: false, lastFlushStartedAt: 0,
        };
        activities.set(event.activityId, state);
      }
      if (!state.projection.accept(event)) return;
      state.latest = ctx;
      if (event.type === "agent-settled") state.settled = true;
      if (state.pending) {
        state.dirty = true;
      } else {
        // Throttle rather than debounce: continuous token deltas must not postpone updates forever.
        if (!state.timer || state.settled) {
          const elapsed = Date.now() - state.lastFlushStartedAt;
          schedule(event.activityId, state.settled ? 0 : Math.max(0, EDIT_INTERVAL_MS - elapsed));
        }
      }
    },
  });

  return () => {
    closed = true;
    dispose();
    for (const id of activities.keys()) clearState(id);
  };
}
