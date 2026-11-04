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
    tools: [], childWork: [], totalChildWork: 0, completedChildWork: 0, failedChildWork: 0, interruptedChildWork: 0, subagentWorkTotal: 0, backgroundWorkTotal: 0, settled: false, phase: "running", updatedAt: 0, startedAt: 0, totalTools: 0, completedTools: 0, failedTools: 0, interruptedTools: 0,
  };
  let reasoningIndex: number | undefined;
  let lastSequence = -1;
  const seenChildIds = new Set<string>();
  const MAX_CHILD_HISTORY = 24;
  const endedChildIds = new Set<string>();
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
        const endingSameSegment = reasoningIndex === event.contentIndex;
        reasoningIndex = event.contentIndex;
        // A final segment must not resurrect content suppressed by earlier deltas.
        snapshot.reasoning = reasoningRedacted && endingSameSegment
          ? "" : safeText(event.text.slice(-MAX_REASONING), MAX_REASONING);
        reasoningRedacted = false;
        break;
      case "assistant-segment":
        if (event.placement === "intermediate") snapshot.plan = safeText(event.text.slice(-MAX_PLAN), MAX_PLAN);
        break;
      case "tool-start":
        if (!event.toolCallId || seenToolIds.has(event.toolCallId)) break;
        seenToolIds.add(event.toolCallId);
        snapshot.totalTools++;
        snapshot.tools.push({ id: event.toolCallId, name: safeText(event.toolName, 70) || "tool", kind: /todo|task/i.test(event.toolName) ? "task" : "tool", command: toolCommand(event.toolName, event.args), startedAt: event.timestamp, state: "running" });
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
      case "child-work-start": {
        if (!event.workId || seenChildIds.has(event.workId)) break;
        seenChildIds.add(event.workId);
        snapshot.totalChildWork++;
        if (event.kind === "subagent") snapshot.subagentWorkTotal++;
        else snapshot.backgroundWorkTotal++;
        snapshot.childWork.push({ id: event.workId, name: safeText(event.label ?? "", 70) || event.kind, kind: event.kind, parentToolCallId: event.parentToolCallId, startedAt: event.timestamp, state: "running" });
        let finishedChildren = snapshot.childWork.reduce((count, child) => count + (child.state !== "running" ? 1 : 0), 0);
        while (finishedChildren > MAX_CHILD_HISTORY) {
          const oldestFinished = snapshot.childWork.findIndex(t => t.state !== "running");
          if (oldestFinished < 0) break;
          snapshot.childWork.splice(oldestFinished, 1);
          finishedChildren--;
        }
        if (snapshot.childWork.length > MAX_ACTIVE_TOOLS) {
          const oldestFinished = snapshot.childWork.findIndex(t => t.state !== "running");
          snapshot.childWork.splice(oldestFinished < 0 ? 0 : oldestFinished, 1);
        }
        break;
      }
      case "child-work-update": {
        if (endedChildIds.has(event.workId)) break;
        const child = snapshot.childWork.find(t => t.id === event.workId && t.state === "running");
        if (child) child.update = safeText(event.message ?? "", 120) || child.update;
        break;
      }
      case "child-work-end": {
        if (!seenChildIds.has(event.workId) || endedChildIds.has(event.workId)) break;
        endedChildIds.add(event.workId);
        if (event.isError) snapshot.failedChildWork++; else snapshot.completedChildWork++;
        const child = snapshot.childWork.find(t => t.id === event.workId && t.state === "running");
        if (child) {
          child.state = event.isError ? "error" : "done";
          child.elapsedMs = Math.max(0, event.timestamp - child.startedAt);
          child.result = event.result ? safeText(event.result ?? "", 120) : undefined;
        }
        let completedHistory = snapshot.childWork.reduce((n, t) => n + (t.state !== "running" ? 1 : 0), 0);
        while (completedHistory > MAX_CHILD_HISTORY) {
          const oldestFinished = snapshot.childWork.findIndex(t => t.state !== "running");
          if (oldestFinished < 0) break;
          snapshot.childWork.splice(oldestFinished, 1);
          completedHistory--;
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
        for (const child of snapshot.childWork) {
          if (child.state === "running") {
            child.state = "interrupted";
            child.elapsedMs = Math.max(0, event.timestamp - child.startedAt);
          }
        }
        snapshot.interruptedChildWork = Math.max(0, snapshot.totalChildWork - snapshot.completedChildWork - snapshot.failedChildWork);
        seenChildIds.clear();
        endedChildIds.clear();
        // Include running records evicted under extreme concurrency.
        snapshot.interruptedTools = Math.max(0, snapshot.totalTools - snapshot.completedTools - snapshot.failedTools);
        seenToolIds.clear();
        finishedToolIds.clear();
        break;
    }
    return true;
  }

  function getSnapshot(): LiveTailSnapshot {
    return { ...snapshot, tools: snapshot.tools.map(t => ({ ...t })), childWork: snapshot.childWork.map(t => ({ ...t })) };
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
    const s = snapshot;
    const cfg = settings as any;

    const pad = (n: number) => String(n).padStart(2, "0");
    const formatTime = (ts: number): string => {
        const d = new Date(ts);
        return `[${pad(d.getHours())}:${pad(d.getMinutes())}]`;
    };

    const formatToolTarget = (toolName: string, raw: unknown): string => {
        const text = String(raw ?? "").trim();
        if (!text) return "";
        const isShell = /bash|terminal|exec|shell|sh/i.test(toolName);
        if (isShell) {
            const clean = text.replace(/\s+/g, " ");
            return clean.length > 95 ? clean.slice(0, 92) + "…" : clean;
        }
        const isFile = /read|write|edit|patch/i.test(toolName);
        if (isFile && /[/\\]/.test(text)) {
            const parts = text.split(/[/\\]/).filter(Boolean);
            return parts.length <= 2 ? parts.join("/") : "…/" + parts.slice(-2).join("/");
        }
        const clean = text.replace(/\s+/g, " ");
        return clean.length > 80 ? clean.slice(0, 77) + "…" : clean;
    };

    const tools: LiveTailTool[] = Array.isArray(s.tools) ? s.tools : [];

    const span = Number.isFinite(s.updatedAt - s.startedAt)
        ? Math.max(0, Math.floor((s.updatedAt - s.startedAt) / 1000)) : 0;
    const elapsed = span >= 60 ? `${Math.floor(span / 60)}m ${span % 60}s` : `${span}s`;

    const modelLabel = cfg.model || (s as any).model || "rvn-q4-km-mtp";

    const combinedReasoning = [s.earlierReasoning, s.reasoning]
        .filter((v: unknown) => typeof v === "string" && (v as string).trim())
        .join("\n\n")
        .trim();

    const parts: string[] = [];

    // 1. Reasoning Section (Large heading '## Reasoning')
    if (cfg.reasoning !== "hidden" && combinedReasoning) {
        const reasoningTail = combinedReasoning.length > 900 ? combinedReasoning.slice(-900) : combinedReasoning;
        parts.push(`## Reasoning\n\n${reasoningTail}`);
    }

    // 2. Tools Section (Large heading '## Tools', bullet lines matching Hermes)
    if (cfg.tools !== "hidden" && tools.length > 0) {
        const lines: string[] = [];
        const MAX_TOOLS = 6;
        const visibleTools = tools.slice(-MAX_TOOLS);

        for (const t of visibleTools) {
            const timeStr = formatTime(t.startedAt || Date.now());
            const mark = t.state === "running" ? "→" : t.state === "error" ? "❌" : "✓";
            const dur = typeof t.elapsedMs === "number" && t.elapsedMs >= 50
                ? ` · ${(t.elapsedMs / 1000).toFixed(1)}s`
                : "";
            const statusText = t.state === "running" ? " · running" : ` · done${dur}`;
            const target = formatToolTarget(t.name, t.command ?? t.update ?? "");
            const targetText = target ? `: ${target}` : "";
            lines.push(`- • ${timeStr} ${mark} ${t.name}${targetText}${statusText}`);
        }

        if (lines.length > 0) {
            parts.push(`## Tools\n\n${lines.join("\n")}`);
        }
    } else if (!s.settled) {
        const timeStr = formatTime(Date.now());
        parts.push(`## Tools\n\n- • ${timeStr} → working...`);
    }

    // 3. Status Section (Large heading '## Status', exact Hermes footer format)
    const ctxLabel = "ctx 2%";
    const statusLine = `${ctxLabel} · compacted 0x · ${modelLabel} · git main · ~/.pi/work · live_tail · ${elapsed}`;
    parts.push(`## Status\n\n${statusLine}`);

    return parts.join("\n\n");
}
