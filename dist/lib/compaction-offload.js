import http from "node:http";
function serializeMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0)
        return "";
    const lines = [];
    for (const msg of messages) {
        const role = String(msg.role || "unknown").toUpperCase();
        let body = "";
        if (typeof msg.content === "string") {
            body = msg.content;
        }
        else if (Array.isArray(msg.content)) {
            const parts = [];
            for (const p of msg.content) {
                if (p.type === "text" && p.text)
                    parts.push(p.text);
                else if (p.type === "toolCall")
                    parts.push(`[Tool Call: ${p.name}(${JSON.stringify(p.arguments || {})})]`);
                else if (p.type === "toolResult") {
                    const textContent = Array.isArray(p.content)
                        ? p.content.filter((c) => c.type === "text").map((c) => c.text).join(" ")
                        : String(p.content || "");
                    parts.push(`[Tool Result (${p.toolName}): ${textContent.slice(0, 400)}]`);
                }
            }
            body = parts.join(" ");
        }
        body = body.trim();
        if (body) {
            lines.push(`[${role}]: ${body.slice(0, 1500)}`);
        }
    }
    const full = lines.join("\n\n");
    return full.length > 40000 ? "..." + full.slice(-40000) : full;
}
export async function offloadCompactionToOmniRoute(event, _ctx) {
    const prep = event?.preparation;
    if (!prep || !prep.firstKeptEntryId) {
        return null;
    }
    const conversationText = serializeMessages(prep.messagesToSummarize);
    if (!conversationText) {
        return null;
    }
    const previousSummary = prep.previousSummary ? `Previous Summary:\n${prep.previousSummary}\n\n` : "";
    const prompt = `${previousSummary}Conversation to compact:\n${conversationText}\n\nProvide a structured, dense summary preserving user requirements, finished tasks, key code/config changes, and pending next steps. Use headings: ## Goal, ## Progress, ## Key Context.`;
    const requestBody = JSON.stringify({
        model: "antigravity/gemini-3.8-flash-tiered",
        messages: [
            {
                role: "system",
                content: "You are an expert coding assistant context summarizer. Generate a concise, structured markdown summary of the conversation history. Do not call any tools. Output only the markdown summary.",
            },
            {
                role: "user",
                content: prompt,
            },
        ],
        max_tokens: 1500,
        temperature: 0.2,
    });
    return new Promise((resolve) => {
        const req = http.request({
            hostname: "100.87.22.76",
            port: 20128,
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer sk-dc84fbe97f6a1b99-f569da-7668abce",
                "Content-Length": Buffer.byteLength(requestBody),
            },
            timeout: 20000,
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data);
                    const summary = parsed?.choices?.[0]?.message?.content?.trim();
                    if (summary) {
                        resolve({
                            compaction: {
                                summary,
                                firstKeptEntryId: prep.firstKeptEntryId,
                                tokensBefore: prep.tokensBefore || 0,
                                details: {
                                    provider: "omniroute",
                                    model: "antigravity/gemini-3.8-flash-tiered",
                                    timestamp: Date.now(),
                                },
                            },
                        });
                        return;
                    }
                }
                catch (_) { }
                resolve(null);
            });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => {
            req.destroy();
            resolve(null);
        });
        req.write(requestBody);
        req.end();
    });
}
