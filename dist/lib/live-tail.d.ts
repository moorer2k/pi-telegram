/**
 * Bounded, transport-independent live-tail projection.
 *
 * This module deliberately does not send Telegram messages. The activity
 * consumer owns one send/edit handle and schedules throttled flushes.
 * Zones: telegram, pi agent
 */
import type { TelegramActivityEvent } from "./activity.ts";
import type { TelegramLiveTailSettings } from "./config.ts";
export interface LiveTailTool {
    id: string;
    name: string;
    command?: string;
    update?: string;
    result?: string;
    kind?: "tool" | "task" | "subagent" | "background";
    parentToolCallId?: string;
    startedAt: number;
    elapsedMs?: number;
    state: "running" | "done" | "error" | "interrupted";
}
export interface LiveTailSnapshot {
    activityId: string;
    reasoning: string;
    earlierReasoning: string;
    plan: string;
    previewText?: string;
    tools: LiveTailTool[];
    childWork: LiveTailTool[];
    totalChildWork: number;
    completedChildWork: number;
    failedChildWork: number;
    interruptedChildWork: number;
    subagentWorkTotal: number;
    backgroundWorkTotal: number;
    settled: boolean;
    phase: "running" | "compacting" | "awaiting-input" | "finished";
    prompt?: string;
    model?: string;
    updatedAt: number;
    startedAt: number;
    totalTools: number;
    completedTools: number;
    failedTools: number;
    interruptedTools: number;
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
/** Build complete HTML sections within the Telegram message limit.
 * Never truncate already-escaped markup or cut through an HTML entity/tag.
 */
export declare function renderLiveTail(snapshot: LiveTailSnapshot, settings?: TelegramLiveTailSettings): string;
