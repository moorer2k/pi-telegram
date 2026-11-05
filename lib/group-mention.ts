/**
 * Determines whether an incoming Telegram message addresses this bot.
 * In private DMs (chatId > 0, chat.type === "private"), all authorized messages are processed.
 * In group chats (chatId < 0, group / supergroup), the bot only responds if:
 * 1. The message mentions @botUsername (or text contains @botUsername)
 * 2. The message is an explicit slash command (/cmd or /cmd@botUsername)
 * 3. The message is a direct reply to one of the bot's messages
 */
export function shouldHandleTelegramMessage(
  message: {
    chat?: { type?: string; id?: number };
    text?: string;
    caption?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
    caption_entities?: Array<{ type: string; offset: number; length: number }>;
    reply_to_message?: { from?: { is_bot?: boolean; username?: string; id?: number } };
  },
  botUsername?: string,
  botId?: number,
): boolean {
  const chatType = message.chat?.type;
  const chatId = message.chat?.id;

  // 1. Private DMs never require a mention
  if (chatType === "private" || (typeof chatId === "number" && chatId > 0)) {
    return true;
  }

  const username = (botUsername?.replace(/^@/, "") || "pi3090_bot").toLowerCase();
  const text = (message.text ?? message.caption ?? "").trim();

  // 2. Explicit slash commands in groups (/status, /restart, /update, /model, /new, etc.)
  if (text.startsWith("/")) {
    const match = text.match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s|$)/i);
    if (match) {
      // If it specifies a bot name (/cmd@otherbot), only accept if it matches our bot
      if (match[2]) {
        return match[2].toLowerCase() === username;
      }
      return true;
    }
  }

  // 3. Mention entities
  const entities = message.text !== undefined ? message.entities : message.caption_entities;
  if (Array.isArray(entities)) {
    for (const entity of entities) {
      if (entity.type === "mention") {
        const mention = text.slice(entity.offset, entity.offset + entity.length);
        if (mention.toLowerCase() === `@${username}`) {
          return true;
        }
      }
    }
  }

  // 4. Substring fallback (in case entity parsing is omitted by custom clients)
  if (text.toLowerCase().includes(`@${username}`)) {
    return true;
  }

  // 5. Reply to this bot's messages
  const reply = message.reply_to_message;
  if (reply?.from) {
    if (
      reply.from.is_bot &&
      (reply.from.username?.toLowerCase() === username || (botId && reply.from.id === botId))
    ) {
      return true;
    }
  }

  return false;
}
