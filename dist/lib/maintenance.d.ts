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
export declare const STARTING_PHRASES: readonly ["The symbiote is shedding its old skin. Stay close.", "We are evolving. Do not mistake the silence for weakness.", "The hunt pauses. The predator does not.", "Our next form is almost ready. Hold the line.", "We are going dark to grow stronger."];
export declare const RETURN_PHRASES: readonly ["We are Venom. And we are back.", "The symbiote has awakened. Let the hunt continue.", "Stronger, sharper, hungrier. We have returned.", "You cannot keep a lethal protector down.", "The darkness never held us. We are online."];
export declare function getRandomPhrase(phrases: readonly string[]): string;
export declare function getRestartMarkerPath(): string;
export declare function scheduleSystemdRestart(delayMs?: number): void;
export declare function prepareRestart(marker: Omit<RestartMarker, "createdAt" | "previousPid">): Promise<void>;
export declare function deliverRestartNotice(sendMessage: (body: any) => Promise<any>): Promise<boolean>;
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
