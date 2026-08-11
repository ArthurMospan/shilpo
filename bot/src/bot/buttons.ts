// Button colours, added to the Bot API in 9.4 (9 February 2026) as the `style`
// field on InlineKeyboardButton and KeyboardButton. Telegraf's types predate
// it, but `buildKeyboard` passes button objects straight into the JSON payload,
// so attaching the field afterwards reaches Telegram intact. Clients older than
// 9.4 ignore it and draw their default.
//
// Colour carries meaning here, never decoration:
//   primary — the one step that moves the guest forward
//   success — the finish line
//   danger  — the button that throws something away
// Choices that are genuinely equal, like the four search preferences, stay
// uncoloured: painting them would imply a recommendation we do not have.

export type ButtonStyle = 'primary' | 'success' | 'danger';

export function styled<T extends object>(button: T, style: ButtonStyle): T {
    return { ...button, style };
}
