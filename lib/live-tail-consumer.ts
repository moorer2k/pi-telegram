/**
 * Optional live-tail consumer. One bounded, editable Telegram message per activity.
 * Delivery remains authorized and generation-fenced by the Activity API.
 */
import { registerTelegramActivityHandler, type TelegramActivityContext, type TelegramActivityEvent } from "./activity.ts";
import { createLiveTailProjection, renderLiveTail } from "./live-tail.ts";
import type { TelegramDeliveryHandle } from "./delivery.ts";
import type { TelegramLiveTailSettings } from "./config.ts";

const EDIT_INTERVAL_MS = 1200;
const MAX_TRACKED_ACTIVITIES = 32;
const RETAIN_SETTLED_MS = 120000;

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
  revision: number;
  cleanupDeadline?: number;
  editFailures: number;
  initialSendAttempted: boolean;
  lastActivityAt: number;
}

export interface LiveTailConsumer {
  dispose(): void;
  onFinalDelivered(chatId: number, replyToMessageId: number | undefined): void;
}

export function registerLiveTailConsumer(getSettings: () => TelegramLiveTailSettings = () => ({})): LiveTailConsumer {
  const activities = new Map<string, LiveTailState>();
  let closed = false;

  function clearState(id: string): void {
    const state = activities.get(id);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    if (state.cleanup) clearTimeout(state.cleanup);
    state.cleanupDeadline = undefined;
    activities.delete(id);
  }

  function schedule(id: string, delay: number): void {
    const state = activities.get(id);
    if (!state || closed || state.failed) return;
    if (state.cleanup) { clearTimeout(state.cleanup); state.cleanup = undefined; }
    delay = Math.max(0, Number.isFinite(delay) ? delay : EDIT_INTERVAL_MS, state.retryNotBefore - Date.now());
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void flush(id);
    }, Math.max(0, delay));
  }

  async function flush(id: string): Promise<void> {
    const state = activities.get(id);
    if (!state || closed || state.pending || state.failed || !state.latest) return;
    if (state.retryNotBefore > Date.now()) {
      schedule(id, state.retryNotBefore - Date.now());
      return;
    }
    if (getSettings().enabled === false) {
      // A disabled consumer must not retain pending timers or activity state.
      clearState(id);
      return;
    }
    state.pending = true;
    state.lastFlushStartedAt = Date.now();
    state.dirty = false;
    const sentRevision = state.revision;
    try {
      const settings = getSettings();
      const text = renderLiveTail(state.projection.getSnapshot(), settings);
      // Do not emit a status-only message for turns without visible activity.
      if (!state.hasContent || text === state.lastText || !text.trim()) {
        // A no-op flush may still have been superseded by a newer event.
        state.dirty = state.revision !== sentRevision;
        return;
      }
      const view = { text, parseMode: "html" as const };
      if (!state.handle && state.initialSendAttempted) {
        state.failed = true;
        state.dirty = false;
        return;
      }
      if (!state.handle) state.initialSendAttempted = true;
      const result = state.handle
        ? await state.latest.edit(state.handle, view)
        : await state.latest.send(view, { replyToMessageId: state.replyToMessageId });
      if (closed || activities.get(id) !== state) return;
      if (result.ok) {
        state.handle = result.value;
        state.lastText = text;
        state.retryNotBefore = 0;
        state.editFailures = 0;
        if (state.revision !== sentRevision) state.dirty = true;
        // A newer event may have arrived while this delivery was in flight.
        // Preserve dirty=true in that case so the latest projection is flushed.
      } else if (result.reason === "rate-limited" && (state.handle || result.partial)) {
        if (result.partial) state.handle = result.partial;
        state.dirty = true;
        state.retryNotBefore = Date.now() + Math.max(EDIT_INTERVAL_MS, Math.min(120000, typeof result.retryAfterMs === "number" && Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : 3000));
        schedule(id, state.retryNotBefore - Date.now());
      } else if (state.handle && result.reason !== "runtime-unavailable" && result.reason !== "unauthorized" && state.editFailures < 3) {
        // Editing an acknowledged message is safe to retry: it cannot create duplicates.
        // Never apply this recovery path to an unacknowledged initial send.
        state.editFailures++;
        state.dirty = true;
        state.retryNotBefore = Date.now() + Math.min(15000, 1500 * 2 ** state.editFailures);
        schedule(id, state.retryNotBefore - Date.now());
      } else {
        // Preserve any acknowledged message handle for final cleanup.
        // Never retry an uncertain send: doing so could create duplicates.
        if (result.partial) state.handle = result.partial;
        state.failed = true;
        state.dirty = false;
      }
    } catch {
      // An acknowledged edit is idempotent; an uncertain initial send is not.
      if (state.handle && state.editFailures < 3) {
        state.editFailures++;
        state.dirty = true;
        state.retryNotBefore = Date.now() + Math.min(15000, 1500 * 2 ** state.editFailures);
        schedule(id, state.retryNotBefore - Date.now());
      } else {
        state.failed = true;
        state.dirty = false;
      }
    } finally {
      state.pending = false;
      if (closed || activities.get(id) !== state) return;
      if (state.dirty && !closed && !state.failed && !state.timer) {
        schedule(id, EDIT_INTERVAL_MS);
      }
      if (state.settled && state.finalDelivered) {
        if (state.failed) {
          state.dirty = false;
          if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
        }
        scheduleAutoDelete(id, state);
      }
      if (state.settled && !state.cleanup && !state.finalDelivered && !state.timer && !state.dirty) {
        state.cleanupDeadline ??= Date.now() + RETAIN_SETTLED_MS;
        state.cleanup = setTimeout(() => clearState(id), Math.max(0, state.cleanupDeadline - Date.now()));
      }
    }
  }

  const dispose = registerTelegramActivityHandler({
    id: "@llblab/pi-telegram/live-tail",
    handle(event: TelegramActivityEvent, ctx: TelegramActivityContext) {
      if (closed || event.source !== "telegram") return;
      if (getSettings().enabled === false) {
        clearState(event.activityId);
        return;
      }
      let state = activities.get(event.activityId);
      if (!state) {
        if (event.type !== "agent-start") return;
        if (activities.size >= MAX_TRACKED_ACTIVITIES) {
          // Prefer expired, settled activities. Never discard a live edit handle.
          for (const [oldId, oldState] of activities) {
            if (activities.size < MAX_TRACKED_ACTIVITIES) break;
            if (oldState.settled && !oldState.pending && !oldState.timer && !oldState.dirty &&
                (oldState.failed || Date.now() - oldState.lastActivityAt >= RETAIN_SETTLED_MS)) clearState(oldId);
          }
          if (activities.size >= MAX_TRACKED_ACTIVITIES) return;
        }
        state = {
          projection: createLiveTailProjection(event.activityId),
          pending: false, dirty: false, failed: false, settled: false, lastFlushStartedAt: 0, retryNotBefore: 0, hasContent: false, finalDelivered: false,
          replyToMessageId: event.replyToMessageId,
          revision: 0,
          editFailures: 0,
          initialSendAttempted: false,
          lastActivityAt: Date.now(),
        };
        activities.set(event.activityId, state);
      }
      if (!state.projection.accept(event)) return;
      state.revision++;
      state.lastActivityAt = Date.now();
      state.latest = ctx;
      if ((event.type === "reasoning-delta" && event.delta.length > 0) ||
          (event.type === "reasoning-end" && event.text.length > 0) ||
          (event.type === "assistant-segment" && event.placement === "intermediate" && event.text.length > 0) ||
          event.type === "tool-start" ||
          event.type === "child-work-start" ||
          event.type === "child-work-update" ||
          event.type === "child-work-end" ||
          event.type === "compaction-start" ||
          event.type === "ui-prompt-start") state.hasContent = true;
      if (event.type === "agent-settled") {
        state.settled = true;
        if (!state.hasContent) { clearState(event.activityId); return; }
      }
      if (state.failed) {
        if (state.settled && state.finalDelivered) {
          state.dirty = false;
          if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
          scheduleAutoDelete(event.activityId, state);
        }
        else if (state.settled && !state.cleanup) {
          state.cleanupDeadline ??= Date.now() + RETAIN_SETTLED_MS;
          state.cleanup = setTimeout(() => clearState(event.activityId), Math.max(0, state.cleanupDeadline - Date.now()));
        }
        return;
      }
      if (state.pending) {
        state.dirty = true;
      } else {
        // Throttle rather than debounce: continuous token deltas must not postpone updates forever.
        if (!state.timer || state.settled) {
          const configuredInterval = getSettings().interval;
          const interval = Math.max(1, Math.min(3, typeof configuredInterval === "number" && Number.isFinite(configuredInterval) ? configuredInterval : 2)) * 1000;
          const elapsed = Date.now() - state.lastFlushStartedAt;
          schedule(event.activityId, state.settled ? 0 : Math.max(0, interval - elapsed));
        }
      }
    },
  });

  function scheduleAutoDelete(id: string, state: LiveTailState): void {
    if (!state.settled || !state.finalDelivered || state.cleanup || closed || state.pending || state.timer || state.dirty) return;
    const delay: Record<string, number | undefined> = {
      keep: undefined, immediate: 0, "5s": 5000, "15s": 15000,
      "30s": 30000, "60s": 60000,
    };
    const ms = delay[getSettings().autoDelete ?? "keep"];
    if (ms === undefined) {
      state.cleanupDeadline ??= Date.now() + RETAIN_SETTLED_MS;
      state.cleanup = setTimeout(() => clearState(id), Math.max(0, state.cleanupDeadline - Date.now()));
      return;
    }
    state.cleanupDeadline ??= Date.now() + ms;
    state.cleanup = setTimeout(() => {
      if (closed || activities.get(id) !== state) return;
      if (state.pending || state.timer || state.dirty) {
        state.cleanup = undefined;
        // The edit completion path re-arms deletion after pending work drains.
        return;
      }
      if (state.handle && state.latest) void state.latest.delete(state.handle).catch(() => {});
      clearState(id);
    }, Math.max(0, state.cleanupDeadline - Date.now()));
  }

  const disposeConsumer = () => {
    closed = true;
    dispose();
    for (const id of activities.keys()) clearState(id);
  };
  const onFinalDelivered = (chatId: number, replyToMessageId: number | undefined) => {
    if (closed) return;
    const candidates = [...activities.entries()].filter(([, state]) => {
      const target = state.handle?.target ?? (state.latest?.defaultScope.kind === "target" ? state.latest.defaultScope.target : undefined);
      return target?.chatId === chatId && state.replyToMessageId === replyToMessageId && !state.finalDelivered;
    });
    // Without an original message ID, multiple turns in one chat are ambiguous.
    if (replyToMessageId === undefined && candidates.length !== 1) return;
    for (const [id, state] of candidates) {
      state.finalDelivered = true;
      if (state.cleanup) { clearTimeout(state.cleanup); state.cleanup = undefined; }
      state.cleanupDeadline = undefined;
      // The final progress edit must complete before an immediate deletion.
      if (state.settled && !state.pending && !state.timer && !state.dirty) scheduleAutoDelete(id, state);
    }
  };
  return { dispose: disposeConsumer, onFinalDelivered };
}
