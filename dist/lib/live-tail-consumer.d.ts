import type { TelegramLiveTailSettings } from "./config.ts";
export interface LiveTailConsumer {
    dispose(): void;
    onFinalDelivered(chatId: number, replyToMessageId: number | undefined): void;
}
export declare function registerLiveTailConsumer(getSettings?: () => TelegramLiveTailSettings): LiveTailConsumer;
