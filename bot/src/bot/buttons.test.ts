import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Markup } from 'telegraf';
import { styled } from './buttons';

// `style` reaches Telegram only because Telegraf copies button objects into the
// payload untouched. That is an implementation detail of a dependency, so it is
// worth a test: if a Telegraf upgrade ever starts filtering unknown keys, the
// buttons would quietly go back to being all one colour.

test('a style survives into the inline keyboard payload', () => {
    const markup = Markup.inlineKeyboard([
        [styled(Markup.button.url('Підключити', 'https://example.com/auth'), 'primary')],
        [styled(Markup.button.callback('Не треба', 'drop:1'), 'danger')],
    ]);

    const rows = (markup.reply_markup as { inline_keyboard: Record<string, unknown>[][] }).inline_keyboard;
    assert.equal(rows[0][0].style, 'primary');
    assert.equal(rows[1][0].style, 'danger');
    assert.equal(rows[0][0].url, 'https://example.com/auth');
});

test('a style survives into the reply keyboard payload', () => {
    const markup = Markup.keyboard([[
        styled(Markup.button.text('📝 Новий список'), 'primary'),
        Markup.button.text('🛒 Мій кошик'),
    ]]).resize().persistent();

    const rows = (markup.reply_markup as { keyboard: Record<string, unknown>[][] }).keyboard;
    assert.equal(rows[0][0].style, 'primary');
    assert.equal(rows[0][0].text, '📝 Новий список');
    // An uncoloured button must stay uncoloured: omitting the field is what
    // lets the client draw its own default.
    assert.equal(rows[0][1].style, undefined);
});

test('styling does not mutate the button it was given', () => {
    const plain = Markup.button.callback('Інше', 'other:1');
    const coloured = styled(plain, 'danger');
    assert.equal((plain as Record<string, unknown>).style, undefined);
    assert.equal((coloured as Record<string, unknown>).style, 'danger');
});
