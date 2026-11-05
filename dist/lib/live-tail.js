const MAX_REASONING = 1200;
const MAX_EARLIER = 2400;
const MAX_PLAN = 400;
const MAX_TOOLS = 32;
const MAX_ACTIVE_TOOLS = 64;
/** Only explicit, bounded display fields are allowed. Suppress actual secrets with [REDACTED]. */
function safePreview(value, max = 180) {
    if (typeof value !== "string")
        return undefined;
    let text = value.replace(/\s+/g, " ").trim();
    if (!text)
        return undefined;
    // Redact actual sensitive API keys / tokens instead of dropping the entire command
    text = text.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
    text = text.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]");
    text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]");
    text = text.replace(/(?:key|token|secret|password|passwd|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
    return text.slice(0, max);
}
function toolCommand(name, args) {
    if (!args || typeof args !== "object" || Array.isArray(args))
        return undefined;
    const data = args;
    const shell = /bash|terminal|exec|shell|command|run|ssh/i.test(name);
    const keys = shell ? ["command", "cmd", "script"] : ["path", "file_path", "filePath", "pattern", "query", "description", "task", "command"];
    for (const key of keys) {
        const value = safePreview(data[key], 180);
        if (value)
            return value;
    }
    for (const v of Object.values(data)) {
        if (typeof v === "string" && v.trim()) {
            const value = safePreview(v, 180);
            if (value)
                return value;
        }
    }
    return undefined;
}
function toolSummary(value) {
    if (typeof value === "string")
        return safePreview(value, 120);
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const data = value;
    for (const key of ["text", "message", "summary", "status", "output"]) {
        const preview = safePreview(data[key], 120);
        if (preview)
            return preview;
    }
    return undefined;
}
function appendBounded(current, addition, limit) {
    return (current + addition).slice(-limit);
}
export function createLiveTailProjection(activityId) {
    const snapshot = {
        activityId, reasoning: "", earlierReasoning: "", plan: "",
        tools: [], childWork: [], totalChildWork: 0, completedChildWork: 0, failedChildWork: 0, interruptedChildWork: 0, subagentWorkTotal: 0, backgroundWorkTotal: 0, settled: false, phase: "running", updatedAt: 0, startedAt: 0, totalTools: 0, completedTools: 0, failedTools: 0, interruptedTools: 0,
    };
    let reasoningIndex;
    let lastSequence = -1;
    const seenChildIds = new Set();
    const MAX_CHILD_HISTORY = 24;
    const endedChildIds = new Set();
    const seenToolIds = new Set();
    const finishedToolIds = new Set();
    let firstTimestampSeen = false;
    const safeText = (value, max) => safePreview(value, max) ?? "";
    const safeReasoning = (value) => safeText(value, MAX_REASONING);
    let reasoningRedacted = false;
    function accept(event) {
        if (event.activityId !== activityId || event.sequence <= lastSequence || snapshot.settled)
            return false;
        if (!Number.isFinite(event.timestamp) || event.timestamp < 0 || !Number.isSafeInteger(event.sequence) || event.sequence < 0)
            return false;
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
                }
                else
                    snapshot.reasoning = safeReasoning(combinedReasoning);
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
                if (event.placement === "intermediate")
                    snapshot.plan = safeText(event.text.slice(-MAX_PLAN), MAX_PLAN);
                break;
            case "tool-start":
                if (!event.toolCallId || seenToolIds.has(event.toolCallId))
                    break;
                seenToolIds.add(event.toolCallId);
                snapshot.totalTools++;
                snapshot.tools.push({ id: event.toolCallId, name: safeText(event.toolName, 70) || "tool", kind: /todo|task/i.test(event.toolName) ? "task" : "tool", command: toolCommand(event.toolName, event.args), startedAt: event.timestamp, state: "running" });
                if (snapshot.tools.length > MAX_TOOLS) {
                    const finishedIndex = snapshot.tools.findIndex(t => t.state !== "running");
                    if (finishedIndex >= 0)
                        snapshot.tools.splice(finishedIndex, 1);
                }
                if (snapshot.tools.length > MAX_ACTIVE_TOOLS) {
                    // Bound pathological concurrency without misreporting an evicted tool as completed.
                    snapshot.tools.shift();
                }
                break;
            case "tool-update": {
                if (finishedToolIds.has(event.toolCallId))
                    break;
                const tool = snapshot.tools.find(t => t.id === event.toolCallId);
                if (tool && tool.state === "running") {
                    const update = toolSummary(event.update);
                    if (update !== undefined)
                        tool.update = update;
                }
                break;
            }
            case "tool-end": {
                const tool = snapshot.tools.find(t => t.id === event.toolCallId);
                if (!seenToolIds.has(event.toolCallId) || finishedToolIds.has(event.toolCallId))
                    break;
                finishedToolIds.add(event.toolCallId);
                if (event.isError)
                    snapshot.failedTools++;
                else
                    snapshot.completedTools++;
                if (tool && tool.state === "running") {
                    tool.state = event.isError ? "error" : "done";
                    tool.elapsedMs = Math.max(0, event.timestamp - tool.startedAt);
                    tool.result = toolSummary(event.result);
                }
                break;
            }
            case "child-work-start": {
                if (!event.workId || seenChildIds.has(event.workId))
                    break;
                seenChildIds.add(event.workId);
                snapshot.totalChildWork++;
                if (event.kind === "subagent")
                    snapshot.subagentWorkTotal++;
                else
                    snapshot.backgroundWorkTotal++;
                snapshot.childWork.push({ id: event.workId, name: safeText(event.label ?? "", 70) || event.kind, kind: event.kind, parentToolCallId: event.parentToolCallId, startedAt: event.timestamp, state: "running" });
                let finishedChildren = snapshot.childWork.reduce((count, child) => count + (child.state !== "running" ? 1 : 0), 0);
                while (finishedChildren > MAX_CHILD_HISTORY) {
                    const oldestFinished = snapshot.childWork.findIndex(t => t.state !== "running");
                    if (oldestFinished < 0)
                        break;
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
                if (endedChildIds.has(event.workId))
                    break;
                const child = snapshot.childWork.find(t => t.id === event.workId && t.state === "running");
                if (child)
                    child.update = safeText(event.message ?? "", 120) || child.update;
                break;
            }
            case "child-work-end": {
                if (!seenChildIds.has(event.workId) || endedChildIds.has(event.workId))
                    break;
                endedChildIds.add(event.workId);
                if (event.isError)
                    snapshot.failedChildWork++;
                else
                    snapshot.completedChildWork++;
                const child = snapshot.childWork.find(t => t.id === event.workId && t.state === "running");
                if (child) {
                    child.state = event.isError ? "error" : "done";
                    child.elapsedMs = Math.max(0, event.timestamp - child.startedAt);
                    child.result = event.result ? safeText(event.result ?? "", 120) : undefined;
                }
                let completedHistory = snapshot.childWork.reduce((n, t) => n + (t.state !== "running" ? 1 : 0), 0);
                while (completedHistory > MAX_CHILD_HISTORY) {
                    const oldestFinished = snapshot.childWork.findIndex(t => t.state !== "running");
                    if (oldestFinished < 0)
                        break;
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
                if (snapshot.phase === "compacting")
                    snapshot.phase = "running";
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
    function getSnapshot() {
        return { ...snapshot, tools: snapshot.tools.map(t => ({ ...t })), childWork: snapshot.childWork.map(t => ({ ...t })) };
    }
    return { accept, getSnapshot };
}
/** Escapes untrusted model and tool text before Telegram HTML rendering. */
export function escapeTelegramHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/** Telegram supports expandable blockquotes, not arbitrary collapsible message sections.
 * Keep current work visible; fold older reasoning and completed tools in detailed mode.
 */
/** Build complete HTML sections within the Telegram message limit.
 * Never truncate already-escaped markup or cut through an HTML entity/tag.
 */
export function renderLiveTail(snapshot, settings = {}) {
    const s = snapshot;
    const cfg = settings;
    const pad = (n) => String(n).padStart(2, "0");
    const formatTime = (ts) => {
        const d = new Date(ts);
        return `[${pad(d.getHours())}:${pad(d.getMinutes())}]`;
    };
    const formatToolTarget = (toolName, raw) => {
        const text = String(raw ?? "").trim();
        if (!text)
            return "";
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
    const tools = Array.isArray(s.tools) ? s.tools : [];
    const childWork = Array.isArray(s.childWork) ? s.childWork : [];
    const nowMs = Date.now();
    const span = Number.isFinite(s.updatedAt - s.startedAt)
        ? Math.max(0, Math.floor((s.updatedAt - s.startedAt) / 1000))
        : Math.max(0, Math.floor((nowMs - s.startedAt) / 1000));
    const elapsed = span >= 60 ? `${Math.floor(span / 60)}m ${span % 60}s` : `${span}s`;
    const modelLabel = cfg.model || s.model || "rvn-q4-km-mtp";
    const combinedReasoning = [s.earlierReasoning, s.reasoning]
        .filter((v) => typeof v === "string" && v.trim())
        .join("\n\n")
        .trim();
    const parts = [];
    // If compacting is in progress, make it front and center
    if (s.phase === "compacting") {
        parts.push("## Compacting Session\n\n🗜 *Summarizing conversation history to preserve context space...*");
    }
    // 1. Reasoning Section - FIRST THING THAT SHOWS
    if (cfg.reasoning !== "hidden" && combinedReasoning && s.phase !== "compacting") {
        if (combinedReasoning.length <= 450) {
            parts.push(`## Reasoning\n\n${combinedReasoning}`);
        }
        else {
            parts.push(`<details><summary>🧠 <b>Reasoning (tap to expand)</b></summary>\n\n${combinedReasoning}\n</details>`);
        }
    }
    // 2. Tools Section with consecutive execution collapsing (x1, x2, x3)
    if (cfg.tools !== "hidden" && tools.length > 0) {
        const groupedTools = [];
        for (const t of tools) {
            const timeStr = formatTime(t.startedAt || nowMs);
            const mark = t.state === "running" ? "→" : t.state === "error" ? "❌" : "✓";
            const liveMs = t.state === "running" && t.startedAt ? nowMs - t.startedAt : (t.elapsedMs ?? 0);
            const target = formatToolTarget(t.name, t.command ?? t.update ?? "");
            const last = groupedTools[groupedTools.length - 1];
            if (last && last.name === t.name && last.target === target && last.state === t.state) {
                last.count += 1;
                last.totalMs += liveMs;
                last.timeStr = timeStr;
            }
            else {
                groupedTools.push({
                    name: t.name,
                    target,
                    timeStr,
                    mark,
                    state: t.state,
                    count: 1,
                    totalMs: liveMs,
                });
            }
        }
        const formatGroupedToolLine = (r) => {
            const countText = r.count > 1 ? ` ×${r.count}` : "";
            const dur = r.totalMs >= 100 ? ` · ${(r.totalMs / 1000).toFixed(1)}s` : "";
            const statusText = r.state === "running" ? ` · running${dur}` : ` · done${dur}`;
            const targetText = r.target ? `: ${r.target}` : "";
            return `- ${r.timeStr} ${r.mark} ${r.name}${targetText}${countText}${statusText}`;
        };
        const MAX_RECENT = 4;
        const visibleTools = groupedTools.slice(-MAX_RECENT);
        const olderTools = groupedTools.slice(0, -MAX_RECENT);
        const visibleLines = visibleTools.map(formatGroupedToolLine);
        parts.push(`## Tools\n\n${visibleLines.join("\n")}`);
        if (olderTools.length > 0) {
            const olderLines = olderTools.map(formatGroupedToolLine);
            const totalOlderCalls = olderTools.reduce((acc, curr) => acc + curr.count, 0);
            parts.push(`<details><summary>📁 <b>Earlier Tools (${totalOlderCalls} calls)</b></summary>\n\n` +
                olderLines.join("\n") +
                "\n</details>");
        }
    }
    else if (!s.settled && s.phase !== "compacting") {
        const timeStr = formatTime(nowMs);
        parts.push(`## Tools\n\n- ${timeStr} → working...`);
    }
    // 3. Background Tasks Dropdown
    if (childWork.length > 0) {
        const formatChild = (c) => {
            const timeStr = formatTime(c.startedAt || nowMs);
            const mark = c.state === "running" ? "→" : c.state === "error" ? "❌" : "✓";
            const liveMs = c.state === "running" && c.startedAt ? nowMs - c.startedAt : c.elapsedMs;
            const dur = typeof liveMs === "number" && liveMs >= 100
                ? ` · ${(liveMs / 1000).toFixed(1)}s`
                : "";
            return `- ${timeStr} ${mark} **Subagent**${c.name ? `: *${c.name}*` : ""}${dur}`;
        };
        parts.push(`<details><summary>👥 <b>Background Tasks (${childWork.length})</b></summary>\n\n` +
            childWork.map(formatChild).join("\n") +
            "\n</details>");
    }
    // 4. Status Section (Clean, concise footer)
    let ctxPercent = "0%";
    if (cfg.contextUsage && typeof cfg.contextUsage.percent === "number") {
        ctxPercent = `${Math.round(cfg.contextUsage.percent)}%`;
    }
    else if (cfg.contextUsage && typeof cfg.contextUsage.tokens === "number" && cfg.contextUsage.contextWindow) {
        const pct = Math.round((cfg.contextUsage.tokens / cfg.contextUsage.contextWindow) * 100);
        ctxPercent = `${pct}%`;
    }
    else if (tools.length > 0 || combinedReasoning.length > 0) {
        const estTokens = 1200 + tools.length * 450 + Math.floor(combinedReasoning.length / 4);
        const estPct = Math.min(99, Math.max(1, Math.round((estTokens / 98304) * 100)));
        ctxPercent = `${estPct}%`;
    }
    const compactionStr = typeof cfg.compactionCount === "number" ? `${cfg.compactionCount}x` : "0x";
    const phasePrefix = s.phase === "compacting" ? "compacting · " : "";
    const statusLine = `ctx ${ctxPercent} · ${phasePrefix}compacted ${compactionStr} · ${modelLabel} · ${elapsed}`;
    parts.push(`## Status\n\n${statusLine}`);
    return parts.join("\n\n");
}
