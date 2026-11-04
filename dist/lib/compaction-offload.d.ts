interface MessagePart {
    type: string;
    text?: string;
    name?: string;
    arguments?: unknown;
    toolName?: string;
    content?: unknown;
}
interface AgentMessageLike {
    role?: string;
    content?: string | MessagePart[];
}
interface PreparationLike {
    firstKeptEntryId?: string;
    messagesToSummarize?: AgentMessageLike[];
    previousSummary?: string;
    tokensBefore?: number;
}
interface SessionBeforeCompactEvent {
    preparation?: PreparationLike;
}
interface CompactionResultPayload {
    compaction: {
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        details: {
            provider: string;
            model: string;
            timestamp: number;
        };
    };
}
export declare function offloadCompactionToOmniRoute(event: SessionBeforeCompactEvent, _ctx?: unknown): Promise<CompactionResultPayload | null>;
export {};
