/**
 * Determines whether an incoming Telegram message addresses this bot.
 * In private DMs (chatId > 0, chat.type === "private"), all authorized messages are processed.
 * In group chats (chatId < 0, group / supergroup), the bot only responds if:
 * 1. The message mentions @botUsername (or text contains @botUsername)
 * 2. The message is an explicit slash command (/cmd or /cmd@botUsername)
 * 3. The message is a direct reply to one of the bot's messages
 */
export declare function shouldHandleTelegramMessage(message: {
    chat?: {
        type?: string;
        id?: number;
    };
    text?: string;
    caption?: string;
    entities?: Array<{
        type: string;
        offset: number;
        length: number;
    }>;
    caption_entities?: Array<{
        type: string;
        offset: number;
        length: number;
    }>;
    reply_to_message?: {
        from?: {
            is_bot?: boolean;
            username?: string;
            id?: number;
        };
    };
}, botUsername?: string, botId?: number): boolean;
