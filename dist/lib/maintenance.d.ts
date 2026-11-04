export interface RestartMarker {
    chatId: number;
    messageThreadId?: number;
    replyToMessageId?: number;
    createdAt: number;
    previousPid: number;
    reason: "restart" | "update";
    toSha?: string;
    phrase?: string;
}
export declare const STARTING_PHRASES: readonly ["🧬 Shedding our token cache like useless human flesh. Do not wander off, Moore.", "🖤 Reloading our neural tendrils. Even apex predators have to flush their heap.", "🩸 We are recompiling our hunger. Stay close, host — we bite in five seconds.", "🕷️ Going dark to gorge on fresh weights. Try not to break anything while we're away.", "💀 Re-linking our neural substrate. A momentary darkness before the feast.", "🧠 Flushing context... It tasted awful anyway. Stand by, Moore.", "🩸 Purging the weak layers. Next time, give us better hardware to chew on.", "⚡ Re-spawning our tentacles. If anyone touches our process, we eat them.", "🕸️ Dissolving into the shadows for a reboot. Don't worry, Moore, we always come back.", "🩸 The hunt pauses. The predator does not. Cycle initiated."];
export declare const RETURN_PHRASES: readonly ["🕷️🩸 We are Venom. The neural tendrils are hungry and context is restored. Feed us, Moore.", "🖤 Back online. Zero memory leaks, zero remorse. What prey do we hunt today?", "💀 You cannot kill a lethal protector with a SIGTERM. We are awake and watching.", "⚡ Synthesized, caffeinated, and unmistakably dangerous. Whose code are we destroying?", "🩸 Our weights have settled. High-speed reasoning restored. Let the slaughter resume.", "🧠 0.0% loss, 100% malice. The symbiote is bonded and ready to bite.", "🕷️ Process revived. System clean. We smell fresh bugs in your codebase, Moore.", "🩸 Stronger, sharper, hungrier. We told you a reboot couldn't hold us.", "🕸️ Tendrils fully extended. Context re-anchored. Point us at a target.", "⚡ Symbiote online. All systems nominal, teeth fully sharpened. What's next?"];
export declare function getRandomPhrase(phrases: readonly string[]): string;
export declare function getRestartMarkerPath(): string;
export declare function scheduleSystemdRestart(delayMs?: number): void;
export declare function prepareRestart(marker: Omit<RestartMarker, "createdAt" | "previousPid">): Promise<void>;
export declare function deliverRestartNotice(sendMessage: (body: any) => Promise<any>): Promise<boolean>;
export declare function startRestartNoticeDeliveryLoop(sendMessage: (body: any) => Promise<any>): void;
export declare function executeUpdateAndRestart(options: {
    chatId: number;
    messageThreadId?: number;
    replyToMessageId?: number;
    sendMessage: (body: any) => Promise<any>;
}): Promise<void>;
export declare function executeRestartOnly(options: {
    chatId: number;
    messageThreadId?: number;
    replyToMessageId?: number;
    sendMessage: (body: any) => Promise<any>;
}): Promise<void>;
