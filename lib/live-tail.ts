/**
 * Bounded, transport-independent live-tail projection.
 *
 * This module deliberately does not send Telegram messages. The activity
 * consumer owns one send/edit handle and schedules throttled flushes.
 */
import type { TelegramActivityEvent } from "./activity.ts";

export interface LiveTailTool {
  id: string;
  name: string;
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

const MAX_REASONING = 500;
const MAX_EARLIER = 600;
const MAX_PLAN = 400;
const MAX_TOOLS = 8;

function appendBounded(current: string, addition: string, limit: number): string {
  return (current + addition).slice(-limit);
}

export function createLiveTailProjection(activityId: string) {
  const snapshot: LiveTailSnapshot = {
    activityId, reasoning: "", earlierReasoning: "", plan: "",
    tools: [], settled: false, updatedAt: 0,
  };
  let reasoningIndex: number | undefined;
  let lastSequence = -1;

  function accept(event: TelegramActivityEvent): boolean {
    if (event.activityId !== activityId || event.sequence <= lastSequence || snapshot.settled) return false;
    lastSequence = event.sequence;
    snapshot.updatedAt = event.timestamp;
    switch (event.type) {
      case "reasoning-delta":
        if (reasoningIndex !== undefined && reasoningIndex !== event.contentIndex) {
          snapshot.earlierReasoning = appendBounded(snapshot.earlierReasoning, snapshot.reasoning + "\n", MAX_EARLIER);
          snapshot.reasoning = "";
        }
        reasoningIndex = event.contentIndex;
        snapshot.reasoning = appendBounded(snapshot.reasoning, event.delta, MAX_REASONING);
        break;
      case "reasoning-end":
        reasoningIndex = event.contentIndex;
        snapshot.reasoning = event.text.slice(-MAX_REASONING);
        break;
      case "assistant-segment":
        if (event.placement === "intermediate") snapshot.plan = event.text.slice(-MAX_PLAN);
        break;
      case "tool-start":
        snapshot.tools.push({ id: event.toolCallId, name: event.toolName.slice(0, 70), startedAt: event.timestamp, state: "running" });
        if (snapshot.tools.length > MAX_TOOLS) snapshot.tools.splice(0, snapshot.tools.length - MAX_TOOLS);
        break;
      case "tool-end": {
        const tool = snapshot.tools.find(t => t.id === event.toolCallId);
        if (tool) {
          tool.state = event.isError ? "error" : "done";
          tool.elapsedMs = Math.max(0, event.timestamp - tool.startedAt);
        }
        break;
      }
      case "agent-settled":
        snapshot.settled = true;
        break;
    }
    return true;
  }

  function getSnapshot(): LiveTailSnapshot {
    return { ...snapshot, tools: snapshot.tools.map(t => ({ ...t })) };
  }
  return { accept, getSnapshot };
}

/** Escapes untrusted model and tool text before Telegram HTML rendering. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Single-message HTML renderer, conservatively below Telegram's 4096-character limit. */
export function renderLiveTail(snapshot: LiveTailSnapshot, settings: TelegramLiveTailSettings = {}): string {
  const parts: string[] = [];
  if (settings.reasoning !== "hidden" && (snapshot.reasoning || snapshot.earlierReasoning)) {
    parts.push("<b>Reasoning</b>");
    if (snapshot.reasoning) parts.push(settings.reasoning === "collapsed" || settings.reasoning === undefined
      ? "<blockquote expandable>" + escapeTelegramHtml(snapshot.reasoning) + "</blockquote>"
      : escapeTelegramHtml(snapshot.reasoning));
    if (snapshot.earlierReasoning) {
      parts.push("<blockquote expandable>" + escapeTelegramHtml(snapshot.earlierReasoning) + "</blockquote>");
    }
  }
  if (settings.detail !== "minimal" && snapshot.plan) parts.push("<b>Plan</b>\n" + escapeTelegramHtml(snapshot.plan));
  if (settings.tools !== "hidden" && snapshot.tools.length) {
    parts.push("<b>Tools</b>");
    for (const tool of snapshot.tools.filter(t => settings.tools !== "active" || t.state === "running").slice(settings.detail === "minimal" ? -1 : settings.detail === "detailed" ? -8 : -4)) {
      const status = tool.state === "running" ? "…" : tool.state === "done" ? "✓" : "×";
      const duration = tool.elapsedMs === undefined ? "" : " · " + (tool.elapsedMs / 1000).toFixed(1) + "s";
      parts.push(status + " <code>" + escapeTelegramHtml(tool.name) + "</code>" + duration);
    }
  }
  parts.push("<b>Status</b>\n" + (snapshot.settled ? "Completed" : "Working"));
  return parts.join("\n\n");
}
