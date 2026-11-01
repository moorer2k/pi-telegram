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
  kind?: "tool" | "task" | "subagent" | "background";
  startedAt: number;
  elapsedMs?: number;
  state: "running" | "done" | "error" | "interrupted";
}

export interface LiveTailSnapshot {
  activityId: string;
  reasoning: string;
  earlierReasoning: string;
  plan: string;
  tools: LiveTailTool[];
  settled: boolean;
  phase: "running" | "compacting" | "awaiting-input" | "finished";
  prompt?: string;
  updatedAt: number;
  startedAt: number;
  totalTools: number;
  completedTools: number;
  failedTools: number;
  interruptedTools: number;
}

const MAX_REASONING = 360;
const MAX_EARLIER = 600;
const MAX_PLAN = 400;
const MAX_TOOLS = 24;
const MAX_ACTIVE_TOOLS = 64;

/** Only explicit, bounded display fields are allowed. Suppress likely secrets. */
function safePreview(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (/\b(?:[A-Za-z0-9+/]{48,}={0,2}|[A-Fa-f0-9]{64,})\b/.test(text)) return undefined;
  // Shell previews can include literal values and URLs containing credentials.
  if (/(?:[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@|(?:^|\s)(?:-p|--password|--token|--secret)(?:=|\s+)|(?:^|\s)[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=)/i.test(text)) return undefined;
  if (/(?:x-api-key|x-auth-token|authorization\s*[:=]|(?:^|\s)--(?:api-key|access-key|client-secret|auth|credential)(?:=|\s+))/i.test(text)) return undefined;
  if (!text) return undefined;
  const forbidden = ["password", "passwd", "secret", "token", "api_key", "apikey", "authorization", "bearer ", "private_key", "credential", ".env", "--key", "--password", "aws_access_key", "session_key"];
  if (forbidden.some(word => text.toLowerCase().includes(word))) return undefined;
  if (/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16})\b/.test(text)) return undefined;
  return text.slice(0, max);
}

function toolCommand(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const data = args as Record<string, unknown>;
  const shell = /bash|terminal|exec|shell|command|run|ssh/i.test(name);
  const keys = shell ? ["command", "cmd", "script"] : ["path", "file_path", "filePath", "pattern", "query", "description", "task", "command"];
  for (const key of keys) {
    const value = safePreview(data[key], 180);
    if (value) return value;
  }
  return undefined;
}

function toolSummary(value: unknown): string | undefined {
  if (typeof value === "string") return safePreview(value, 120);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  for (const key of ["text", "message", "summary", "status", "output"]) {
    const preview = safePreview(data[key], 120);
    if (preview) return preview;
  }
  return undefined;
}

function appendBounded(current: string, addition: string, limit: number): string {
  return (current + addition).slice(-limit);
}

export function createLiveTailProjection(activityId: string) {
  const snapshot: LiveTailSnapshot = {
    activityId, reasoning: "", earlierReasoning: "", plan: "",
    tools: [], settled: false, phase: "running", updatedAt: 0, startedAt: 0, totalTools: 0, completedTools: 0, failedTools: 0, interruptedTools: 0,
  };
  let reasoningIndex: number | undefined;
  let lastSequence = -1;
  const seenToolIds = new Set<string>();
  const finishedToolIds = new Set<string>();
  let firstTimestampSeen = false;
  const safeText = (value: string, max: number) => safePreview(value, max) ?? "";
  const safeReasoning = (value: string) => safeText(value, MAX_REASONING);
  let reasoningRedacted = false;

  function accept(event: TelegramActivityEvent): boolean {
    if (event.activityId !== activityId || event.sequence <= lastSequence || snapshot.settled) return false;
    if (!Number.isFinite(event.timestamp) || event.timestamp < 0 || !Number.isSafeInteger(event.sequence) || event.sequence < 0) return false;
    lastSequence = event.sequence;
    snapshot.updatedAt = Math.max(snapshot.updatedAt, event.timestamp);
    if (!firstTimestampSeen) {
      snapshot.startedAt = event.timestamp;
      firstTimestampSeen = true;
    }
    switch (event.type) {
      case "reasoning-delta":
        if (reasoningIndex !== undefined && reasoningIndex !== event.contentIndex) {
          snapshot.earlierReasoning = appendBounded(snapshot.earlierReasoning, snapshot.reasoning + "\n", MAX_EARLIER);
          snapshot.reasoning = "";
          reasoningRedacted = false;
        }
        reasoningIndex = event.contentIndex;
        const combinedReasoning = appendBounded(snapshot.reasoning, event.delta, MAX_REASONING);
        if (reasoningRedacted || (combinedReasoning && !safeReasoning(combinedReasoning))) {
          snapshot.reasoning = "";
          reasoningRedacted = true;
        } else snapshot.reasoning = safeReasoning(combinedReasoning);
        break;
      case "reasoning-end":
        if (reasoningIndex !== undefined && reasoningIndex !== event.contentIndex && snapshot.reasoning) {
          snapshot.earlierReasoning = appendBounded(snapshot.earlierReasoning, snapshot.reasoning + "\n", MAX_EARLIER);
        }
        reasoningIndex = event.contentIndex;
        snapshot.reasoning = safeText(event.text.slice(-MAX_REASONING), MAX_REASONING);
        reasoningRedacted = false;
        break;
      case "assistant-segment":
        if (event.placement === "intermediate") snapshot.plan = safeText(event.text.slice(-MAX_PLAN), MAX_PLAN);
        break;
      case "tool-start":
        if (!event.toolCallId || seenToolIds.has(event.toolCallId)) break;
        seenToolIds.add(event.toolCallId);
        snapshot.totalTools++;
        snapshot.tools.push({ id: event.toolCallId, name: safeText(event.toolName, 70) || "tool", kind: /subagent|delegate|spawn/i.test(event.toolName) ? "subagent" : /background|process|job/i.test(event.toolName) ? "background" : /todo|task/i.test(event.toolName) ? "task" : "tool", command: toolCommand(event.toolName, event.args), startedAt: event.timestamp, state: "running" });
        if (snapshot.tools.length > MAX_TOOLS) {
          const finishedIndex = snapshot.tools.findIndex(t => t.state !== "running");
          if (finishedIndex >= 0) snapshot.tools.splice(finishedIndex, 1);
        }
        if (snapshot.tools.length > MAX_ACTIVE_TOOLS) {
          // Bound pathological concurrency without misreporting an evicted tool as completed.
          snapshot.tools.shift();
        }
        break;
      case "tool-update": {
        if (finishedToolIds.has(event.toolCallId)) break;
        const tool = snapshot.tools.find(t => t.id === event.toolCallId);
        if (tool && tool.state === "running") {
          const update = toolSummary(event.update);
          if (update !== undefined) tool.update = update;
        }
        break;
      }
      case "tool-end": {
        const tool = snapshot.tools.find(t => t.id === event.toolCallId);
        if (!seenToolIds.has(event.toolCallId) || finishedToolIds.has(event.toolCallId)) break;
        finishedToolIds.add(event.toolCallId);
        if (event.isError) snapshot.failedTools++; else snapshot.completedTools++;
        if (tool && tool.state === "running") {
          tool.state = event.isError ? "error" : "done";
          tool.elapsedMs = Math.max(0, event.timestamp - tool.startedAt);
          tool.result = toolSummary(event.result);
        }
        break;
      }
      case "compaction-start":
        snapshot.phase = "compacting";
        snapshot.prompt = undefined;
        break;
      case "compaction-end":
        if (snapshot.phase === "compacting") snapshot.phase = "running";
        break;
      case "ui-prompt-start":
        snapshot.phase = "awaiting-input";
        snapshot.prompt = event.title ? safeText(event.title, 120) || "Input requested" : event.kind;
        break;
      case "ui-prompt-end":
        if (snapshot.phase === "awaiting-input") {
          snapshot.phase = "running";
          snapshot.prompt = undefined;
        }
        break;
      case "agent-settled":
        snapshot.phase = "finished";
        snapshot.prompt = undefined;
        snapshot.settled = true;
        for (const tool of snapshot.tools) {
          if (tool.state === "running") {
            tool.state = "interrupted";
            tool.elapsedMs = Math.max(0, event.timestamp - tool.startedAt);
          }
        }
        // Include running records evicted under extreme concurrency.
        snapshot.interruptedTools = Math.max(0, snapshot.totalTools - snapshot.completedTools - snapshot.failedTools);
        seenToolIds.clear();
        finishedToolIds.clear();
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
  const safeClean = (value: string, max: number) => clean(safePreview(value, max) ?? "", max);
  const elapsedSeconds = Number.isFinite(snapshot.updatedAt - snapshot.startedAt)
    ? Math.max(0, Math.floor((snapshot.updatedAt - snapshot.startedAt) / 1000)) : 0;
  const safeDuration = (ms: number) => Number.isFinite(ms) && ms >= 0 ? (ms / 1000).toFixed(1) + "s" : "0.0s";
  const expandable = (value: string) => "<blockquote expandable>" + value + "</blockquote>";
  const phaseStatus = snapshot.settled ? (snapshot.failedTools ? "Finished with errors" : snapshot.interruptedTools ? "Interrupted" : "Completed")
    : snapshot.phase === "awaiting-input" ? "Awaiting input" : snapshot.phase === "compacting" ? "Compacting context" : "Working";
  const tools = snapshot.tools;
  const active = tools.filter(t => t.state === "running");
  const hiddenActiveCount = Math.max(0, snapshot.totalTools - snapshot.completedTools - snapshot.failedTools - snapshot.interruptedTools - active.length);
  const activeCount = Math.max(0, snapshot.totalTools - snapshot.completedTools - snapshot.failedTools - snapshot.interruptedTools);
  const jobs = active.filter(t => t.kind === "subagent" || t.kind === "background" || t.kind === "task");
  const finished = tools.filter(t => t.state !== "running");
  const line = (tool: LiveTailTool, compact = false) => {
    const status = tool.state === "running" ? "[RUN]" : tool.state === "error" ? "[ERR]" : tool.state === "interrupted" ? "[STOP]" : "[OK]";
    const command = tool.command ? " " + safeClean(tool.command, compact ? 90 : 160) : "";
    const update = !compact && tool.update ? "\n" + safeClean(tool.update, 90) : "";
    const duration = tool.elapsedMs === undefined ? "" : " (" + safeDuration(tool.elapsedMs) + ")";
    const result = !compact && tool.state !== "running" && tool.result ? "\n" + safeClean(tool.result, 90) : "";
    return status + " <code>" + (safeClean(tool.name, 50) || "tool") + command + "</code>" + duration + update + result;
  };
  if (detail === "detailed") add("<b>VENOM // LIVE TAIL</b>");
  if (snapshot.phase === "compacting") add("<b>SESSION</b>\nCompacting context");
  if (snapshot.phase === "awaiting-input") add("<b>AWAITING INPUT</b>\n" + (safeClean(snapshot.prompt ?? "User input", 120) || "Input requested"));
  if (!snapshot.settled && active.length && settings.tools !== "hidden") {
    const current = active.slice(-2);
    add("<b>ACTIVE OPERATIONS</b>\n" + current.map(t => line(t)).join("\n") + (active.length > current.length ? "\n+" + (active.length - current.length) + " other active" : "") + (hiddenActiveCount ? "\n+" + hiddenActiveCount + " untracked in visible history" : ""));
  } else {
    add("<b>CURRENT STATUS</b>\n" + phaseStatus);
  }
  if (!snapshot.settled && detail !== "minimal" && settings.tools !== "hidden" && jobs.length > 2) add("<b>ONGOING TASKS</b>\n" + jobs.slice(-4).map(t => safeClean(t.name, 50) || "tool").join("\n"));
  if (detail !== "minimal" && snapshot.plan) {
    add("<b>CURRENT TASK</b>\n" + safeClean(snapshot.plan.slice(-200), 200));
  }
  const done = snapshot.completedTools;
  const errors = snapshot.failedTools;
  const interrupted = snapshot.interruptedTools;
  add("<b>STATUS</b>\n" + done + " done / " + activeCount + " active" + (errors ? " / " + errors + " errors" : "") + (interrupted ? " / " + interrupted + " interrupted" : "") + " / " + elapsedSeconds + "s");
  if (settings.tools !== "hidden" && settings.tools !== "active" && finished.length) {
    const recent = finished.slice(-(detail === "detailed" ? 5 : 2));
    add("<b>RECENT OPERATIONS</b>\n" + recent.map(t => line(t, detail !== "detailed")).join("\n"));
    if (detail === "detailed" && finished.length > 2) {
      const history = finished.slice(-17, -5);
      if (history.length) add("<i>Earlier operations (" + history.length + ")</i>\n" + expandable(history.map(t => line(t, true)).join("\n")));
    }
  }
  if (reasoningMode !== "hidden" && snapshot.reasoning && detail !== "minimal") {
    const summary = safeClean(snapshot.reasoning.slice(-240), 240);
    add("<b>REASONING</b>\n" + (reasoningMode === "expanded" ? summary : expandable(summary)));
  }
  if (reasoningMode !== "hidden" && detail === "detailed" && snapshot.earlierReasoning) {
    add("<i>Earlier reasoning</i>\n" + expandable(safeClean(snapshot.earlierReasoning.slice(-350), 350)));
  }
  return parts.join("\n\n");
}
