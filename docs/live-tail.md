# Live Tail (experimental)

Live Tail consolidates Pi's Telegram-originated reasoning, intermediate commentary, and tool activity into one editable Telegram HTML message. Final assistant answers still use the normal reply renderer.

## Enable

Set `PI_TELEGRAM_LIVE_TAIL=1` in the environment of the **Pi process** and restart Pi. This option is evaluated when a session starts. It is off by default.

```sh
PI_TELEGRAM_LIVE_TAIL=1 pi
```

**Build required:** this package loads its compiled `dist/` entrypoint. From a working clone run `npm ci && npm run build` before testing the feature. Changing `lib/` alone does not change an installed runtime.

## Behavior

- A single activity message is created after activity starts and useful output arrives.
- Edits are throttled to roughly 1.2 seconds; continuous tokens do not postpone updates indefinitely.
- Earlier reasoning is displayed in Telegram's expandable blockquote. Only reasoning actually exposed by the model is displayed.
- Intermediate commentary appears under Plan; recent tool calls show their names, states, and durations.
- Activity text is escaped as Telegram HTML and bounded to avoid oversized messages.
- Telegram-originated activity only; local and autonomous runs are not pushed to Telegram.
- The existing intermediate-commentary and activity projection are suppressed in this mode. Final replies and attachments use their original delivery paths.
- Edits respect delivery authority. Unknown acknowledgements and stale handles do not cause replacement messages.
- Rate-limit retry delays are honored. Session shutdown disposes the consumer.

## Validation checklist

1. Run `npm run typecheck`, `npm test`, and `npm run build`.
2. Run `npm run build:check` after building.
3. Start a Telegram request that emits reasoning and multiple tools. Confirm exactly one activity message is edited and the final reply is separate.
4. Stream text continuously for at least 15 seconds. Confirm activity edits arrive during generation.
5. Run requests from two different Telegram chats. Confirm there is no cross-chat activity leakage.
6. Exercise cancellation, session shutdown, reconnect, and Telegram flood control.
7. Run with the environment variable unset. Confirm the original activity behavior is unchanged.

This feature is experimental until the above checks pass in a live Telegram environment.
