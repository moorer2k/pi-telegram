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
    timer?: ReturnType<typeof setTimeout>;
    latest?: TelegramActivityContext;
  }>();
  let closed = false;

  const flush = async (id: string) => {
    const state = activities.get(id);
    if (!state || closed || state.pending || !state.latest) return;
    state.pending = true;
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
      }
    } finally {
      state.pending = false;
    }
  };

  const dispose = registerTelegramActivityHandler({
    id: "@llblab/pi-telegram/live-tail",
    handle(event: TelegramActivityEvent, ctx: TelegramActivityContext) {
      if (closed) return;
      let state = activities.get(event.activityId);
      if (!state) {
        state = { projection: createLiveTailProjection(event.activityId), pending: false };
        activities.set(event.activityId, state);
      }
      if (!state.projection.accept(event)) return;
      state.latest = ctx;
      if (state.timer) clearTimeout(state.timer);
      const settled = event.type === "agent-settled";
      state.timer = setTimeout(() => {
        state!.timer = undefined;
        void flush(event.activityId);
        if (settled) {
          // Allow the final flush to finish before forgetting local state.
          setTimeout(() => activities.delete(event.activityId), 3000);
        }
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
