/**
 * Bounded, transport-independent live-tail projection.
 *
 * This module deliberately does not send Telegram messages. The activity
 * consumer owns one send/edit handle and schedules throttled flushes.
 */
import type { TelegramActivityEvent } from "./activity.ts";
import type { TelegramLiveTailSettings } from "./config.ts";
export interface LiveTailTool {
    id: string;
    name: string;
    command?: string;
    startedAt: number;
    elapsedMs?: number;
    state: "running" | "done" | "error";
}
export interface LiveTailSnapshot {
    activityId: string;
    reasoning: string;
    earlierReasoning: string;
    plan: string;
    tools: LiveTailTool[];
    settled: boolean;
    updatedAt: number;
}
export declare function createLiveTailProjection(activityId: string): {
    accept: (event: TelegramActivityEvent) => boolean;
    getSnapshot: () => LiveTailSnapshot;
};
/** Escapes untrusted model and tool text before Telegram HTML rendering. */
export declare function escapeTelegramHtml(text: string): string;
/** Telegram supports expandable blockquotes, not arbitrary collapsible message sections.
 * Keep current work visible; fold older reasoning and completed tools in detailed mode.
 */
export declare function renderLiveTail(snapshot: LiveTailSnapshot, settings?: TelegramLiveTailSettings): string;
