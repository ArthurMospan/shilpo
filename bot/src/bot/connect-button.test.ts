import assert from 'node:assert/strict';
import { test } from 'node:test';

// A throwaway database and a fixed address, whatever the developer's .env says.
process.env.TURSO_DATABASE_URL = '';
process.env.DATABASE_PATH = ':memory:';
process.env.BOT_TOKEN = 'test-token';
process.env.WEBAPP_URL = 'https://shilpo.example';

test('the connect button opens the Silpo login inside Telegram, not in a browser', async () => {
    const { connectKeyboard } = await import('./conversation');
    const [[button]] = (connectKeyboard(42).reply_markup as any).inline_keyboard;
    assert.ok(button.web_app, 'expected a Mini App button');
    assert.equal(button.url, undefined);
    assert.match(button.web_app.url, /^https:\/\/shilpo\.example\/api\/auth\/start\?tg_id=42&exp=\d+&sig=/);
});
