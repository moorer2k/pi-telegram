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

/** Telegram supports expandable blockquotes, not arbitrary collapsible message sections.
 * Keep current work visible; fold older reasoning and completed tools in detailed mode.
 */
export function renderLiveTail(snapshot: LiveTailSnapshot, settings: TelegramLiveTailSettings = {}): string {
  const detail = settings.detail ?? "standard";
  const parts: string[] = [];
  const expandable = (value: string) => "<blockquote expandable>" + value + "</blockquote>";
  const clean = (value: string, max: number) => escapeTelegramHtml(value.slice(-max));
  const reasoning = settings.reasoning ?? "collapsed";

  if (reasoning !== "hidden" && (snapshot.reasoning || snapshot.earlierReasoning)) {
    const reasoningParts: string[] = [];
    if (snapshot.reasoning) {
      const current = clean(snapshot.reasoning, detail === "detailed" ? 850 : detail === "minimal" ? 180 : 450);
      reasoningParts.push(reasoning === "expanded" ? current : expandable(current));
    }
    if (snapshot.earlierReasoning && detail !== "minimal") {
      reasoningParts.push("<i>Earlier reasoning · tap to expand</i>\n" + expandable(clean(snapshot.earlierReasoning, 750)));
    }
    parts.push("<b>Reasoning</b>\n" + reasoningParts.join("\n"));
  }

  if (detail !== "minimal" && snapshot.plan) {
    parts.push("<b>Plan</b>\n" + clean(snapshot.plan, detail === "detailed" ? 750 : 350));
  }

  if (settings.tools !== "hidden" && snapshot.tools.length) {
    const all = snapshot.tools.filter(t => settings.tools !== "active" || t.state === "running");
    const max = detail === "minimal" ? 1 : detail === "detailed" ? 8 : 4;
    const selected = all.slice(-max);
    const renderTool = (tool: LiveTailTool): string => {
      const status = tool.state === "running" ? "…" : tool.state === "done" ? "✓" : "×";
      const duration = tool.elapsedMs === undefined ? "" : " · " + (tool.elapsedMs / 1000).toFixed(1) + "s";
      return status + " <code>" + clean(tool.name, 90) + "</code>" + duration;
    };
    const active = selected.filter(t => t.state === "running");
    const finished = selected.filter(t => t.state !== "running");
    const rows: string[] = [];
    if (active.length) rows.push(...active.map(renderTool));
    if (finished.length) {
      if (detail === "detailed") {
        rows.push("<i>Completed tools (" + finished.length + ") · tap to expand</i>\n" + expandable(finished.map(renderTool).join("\n")));
      } else if (detail === "standard") {
        rows.push(...finished.slice(-2).map(renderTool));
      } else if (!active.length) {
        rows.push(renderTool(finished[finished.length - 1]));
      }
    }
    if (rows.length) parts.push("<b>Tools</b>\n" + rows.join("\n"));
  }

  const running = snapshot.tools.filter(t => t.state === "running").length;
  const completed = snapshot.tools.filter(t => t.state === "done").length;
  const failed = snapshot.tools.filter(t => t.state === "error").length;
  const status = snapshot.settled ? "Completed" : running ? "Running " + running + " tool" + (running === 1 ? "" : "s") : "Working";
  const counters = detail === "detailed" ? "\nTools: " + completed + " done" + (failed ? " · " + failed + " failed" : "") + " · " + running + " active" : "";
  parts.push("<b>Status</b>\n" + status + counters);
  return parts.join("\n\n").slice(0, 3900);
}
