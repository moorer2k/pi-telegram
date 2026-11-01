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
  update?: string;
  result?: string;
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
  startedAt: number;
  totalTools: number;
  completedTools: number;
  failedTools: number;
}

const MAX_REASONING = 360;
const MAX_EARLIER = 600;
const MAX_PLAN = 400;
const MAX_TOOLS = 24;

/** Only surface an explicit command/path, never arbitrary serialized tool arguments.
 * Reject credential-bearing or shell-environment assignments before showing a preview.
 */
function toolCommand(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const data = args as Record<string, unknown>;
  const candidates = /^(bash|terminal|exec|shell|command|run|ssh)$/i.test(name)
    ? ["command", "cmd", "script"]
    : /^(read_file|write_file|edit_file|read|write|edit|grep|find|ls|search)$/i.test(name)
      ? ["path", "file_path", "filePath", "pattern", "query"]
      : [];
  const key = candidates.find(k => typeof data[k] === "string");
  if (!key) return undefined;
  const value = String(data[key]).replace(/[\r\n\t]+/g, " ").trim();
  if (!value || /(?:password|passwd|secret|token|api[_-]?key|authorization|bearer|private[_-]?key|credential|--password|--token|--key|\.env(?:\b|\/))/i.test(value)) return undefined;
  if (/(?:^|\s)[A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|TOKEN|SECRET|KEY)\s*=/.test(value)) return undefined;
  return value.length > 180 ? value.slice(0, 177) + "..." : value;
}


function appendBounded(current: string, addition: string, limit: number): string {
  return (current + addition).slice(-limit);
}

export function createLiveTailProjection(activityId: string) {
  const snapshot: LiveTailSnapshot = {
    activityId, reasoning: "", earlierReasoning: "", plan: "",
    tools: [], settled: false, updatedAt: 0, startedAt: 0, totalTools: 0, completedTools: 0, failedTools: 0,
  };
  let reasoningIndex: number | undefined;
  let lastSequence = -1;

  function accept(event: TelegramActivityEvent): boolean {
    if (event.activityId !== activityId || event.sequence <= lastSequence || snapshot.settled) return false;
    lastSequence = event.sequence;
    snapshot.updatedAt = event.timestamp;
    if (!snapshot.startedAt) snapshot.startedAt = event.timestamp;
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
        snapshot.totalTools++;
        snapshot.tools.push({ id: event.toolCallId, name: event.toolName.slice(0, 70), command: toolCommand(event.toolName, event.args), startedAt: event.timestamp, state: "running" });
        if (snapshot.tools.length > MAX_TOOLS) snapshot.tools.splice(0, snapshot.tools.length - MAX_TOOLS);
        break;
      case "tool-update": {
        const tool = snapshot.tools.find(t => t.id === event.toolCallId);
        if (tool && typeof event.update === "string") tool.update = event.update.slice(-160);
        break;
      }
      case "tool-end": {
        const tool = snapshot.tools.find(t => t.id === event.toolCallId);
        if (tool && tool.state === "running") {
          if (event.isError) snapshot.failedTools++; else snapshot.completedTools++;
          tool.state = event.isError ? "error" : "done";
          tool.elapsedMs = Math.max(0, event.timestamp - tool.startedAt);
          if (event.isError && typeof event.result === "string") tool.result = event.result.slice(0, 120);
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
/** Build complete HTML sections within the Telegram message limit.
 * Never truncate already-escaped markup or cut through an HTML entity/tag.
 */
export function renderLiveTail(snapshot: LiveTailSnapshot, settings: TelegramLiveTailSettings = {}): string {
  const detail = settings.detail ?? "standard";
  const reasoningMode = settings.reasoning ?? "collapsed";
  const parts: string[] = [];
  const budget = 3800;
  let used = 0;
  const add = (section: string) => {
    const cost = section.length + (parts.length ? 2 : 0);
    if (used + cost > budget) return false;
    parts.push(section);
    used += cost;
    return true;
  };
  const clean = (value: string, max: number) => escapeTelegramHtml(value.slice(0, max));
  const expandable = (value: string) => "<blockquote expandable>" + value + "</blockquote>";
  const tools = snapshot.tools;
  const active = tools.filter(t => t.state === "running");
  const finished = tools.filter(t => t.state !== "running");
  const line = (tool: LiveTailTool, compact = false) => {
    const status = tool.state === "running" ? "[RUN]" : tool.state === "error" ? "[ERR]" : "[OK]";
    const command = tool.command ? " " + clean(tool.command, compact ? 90 : 160) : "";
    const update = !compact && tool.update ? "\n" + clean(tool.update, 90) : "";
    const duration = tool.elapsedMs === undefined ? "" : " (" + (tool.elapsedMs / 1000).toFixed(1) + "s)";
    return status + " <code>" + clean(tool.name, 50) + command + "</code>" + duration + update;
  };
  if (detail === "detailed") add("<b>VENOM // LIVE TAIL</b>");
  if (active.length && settings.tools !== "hidden") {
    const current = active.slice(-2);
    add("<b>ACTIVE OPERATIONS</b>\n" + current.map(t => line(t)).join("\n"));
  } else {
    add("<b>CURRENT STATUS</b>\n" + (snapshot.settled ? "Completed" : "Working"));
  }
  if (detail !== "minimal" && snapshot.plan) {
    add("<b>CURRENT TASK</b>\n" + clean(snapshot.plan.slice(-200), 200));
  }
  if (settings.tools !== "hidden" && settings.tools !== "active" && finished.length) {
    const recent = finished.slice(-(detail === "detailed" ? 5 : 2));
    add("<b>RECENT OPERATIONS</b>\n" + recent.slice(-2).map(t => line(t, true)).join("\n"));
    if (detail === "detailed" && finished.length > 2) {
      const history = finished.slice(-12, -2);
      if (history.length) add("<i>Earlier operations (" + history.length + ")</i>\n" + expandable(history.map(t => line(t, true)).join("\n")));
    }
  }
  const done = snapshot.completedTools;
  const errors = snapshot.failedTools;
  add("<b>STATUS</b>\n" + done + " done / " + active.length + " active" + (errors ? " / " + errors + " errors" : ""));
  if (reasoningMode !== "hidden" && snapshot.reasoning && detail !== "minimal") {
    const summary = clean(snapshot.reasoning.slice(-240), 240);
    add("<b>REASONING</b>\n" + (reasoningMode === "expanded" ? summary : expandable(summary)));
  }
  if (reasoningMode !== "hidden" && detail === "detailed" && snapshot.earlierReasoning) {
    add("<i>Earlier reasoning</i>\n" + expandable(clean(snapshot.earlierReasoning.slice(-350), 350)));
  }
  return parts.join("\n\n");
}
