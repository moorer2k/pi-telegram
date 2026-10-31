/**
 * Optional live-tail consumer for the public Activity API.
 * One Telegram message per activity, edited on a bounded cadence.
 */
import { registerTelegramActivityHandler, type TelegramActivityContext, type TelegramActivityEvent } from "./activity.ts";
import { createLiveTailProjection, renderLiveTail } from "./live-tail.ts";
import type { TelegramDeliveryHandle } from "./delivery.ts";

export function registerLiveTailConsumer() {
  const activities = new Map<string, {
    projection: ReturnType<typeof createLiveTailProjection>;
    handle?: TelegramDeliveryHandle;
    lastText?: string;
    pending: boolean;
    dirty: boolean;
    timer?: ReturnType<typeof setTimeout>;
    latest?: TelegramActivityContext;
    failed: boolean;
  }>();
  let closed = false;

  const flush = async (id: string) => {
    const state = activities.get(id);
    if (!state || closed || state.pending || !state.latest || state.failed) return;
    state.pending = true;
    state.dirty = false;
    try {
      const text = renderLiveTail(state.projection.getSnapshot());
      if (text === state.lastText || text === "<b>Status</b>\nWorking") return;
      const view = { text, parseMode: "html" as const };
      const result = state.handle
        ? await state.latest.edit(state.handle, view)
        : await state.latest.send(view);
      if (result.ok) {
        state.handle = result.value;
        state.lastText = text;
      } else if (result.reason === "stale-handle" || result.reason === "target-unauthorized" || result.reason === "commit-unknown" || result.reason === "message-unavailable") {
        // Never send a replacement after an uncertain or stale edit.
        state.failed = true;
      }
    } catch {
      // Activity rendering must never interrupt the Pi lifecycle.
      state.failed = true;
    } finally {
      state.pending = false;
      if (state.dirty && !closed) {
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => { state!.timer = undefined; void flush(id); }, 1200);
      }
    }
  };

  const dispose = registerTelegramActivityHandler({
    id: "@llblab/pi-telegram/live-tail",
    handle(event: TelegramActivityEvent, ctx: TelegramActivityContext) {
      if (closed) return;
      let state = activities.get(event.activityId);
      if (!state) {
        state = { projection: createLiveTailProjection(event.activityId), pending: false, dirty: false, failed: false };
        activities.set(event.activityId, state);
      }
      if (!state.projection.accept(event)) return;
      state.latest = ctx;
      if (state.pending) { state.dirty = true; return; }
      if (state.timer) clearTimeout(state.timer);
      const settled = event.type === "agent-settled";
      state.timer = setTimeout(() => {
        state!.timer = undefined;
        void flush(event.activityId);
  
      }, settled ? 0 : 1200);
    },
  });

  return () => {
    closed = true;
    dispose();
    for (const state of activities.values()) if (state.timer) clearTimeout(state.timer);
    activities.clear();
  };
}
