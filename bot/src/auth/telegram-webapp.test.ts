import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { telegramUserFromInitData } from './telegram-webapp';

const BOT_TOKEN = '123456:TEST-TOKEN-FOR-UNIT-TESTS';
process.env.BOT_TOKEN = BOT_TOKEN;

function sign(fields: Record<string, string>, omitFromCheck: string[]): string {
    const checkString = Object.entries(fields)
        .filter(([key]) => !omitFromCheck.includes(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
    return new URLSearchParams({ ...fields, hash }).toString();
}

function baseFields(overrides: Record<string, string> = {}): Record<string, string> {
    return {
        auth_date: String(Math.floor(Date.now() / 1000)),
        query_id: 'AAE1',
        user: JSON.stringify({ id: 42, first_name: 'Артур' }),
        ...overrides,
    };
}

test('a payload signed without the signature field is accepted', () => {
    const initData = sign(baseFields(), ['hash']);
    assert.equal(telegramUserFromInitData(initData), 42);
});

test('a payload whose signature field is part of the check string is accepted', () => {
    const fields = baseFields({ signature: 'ed25519-placeholder' });
    assert.equal(telegramUserFromInitData(sign(fields, ['hash'])), 42);
});

test('a payload whose signature field is excluded from the check string is also accepted', () => {
    // Telegram clients disagree on this; both readings must launch the Mini App.
    const fields = baseFields({ signature: 'ed25519-placeholder' });
    assert.equal(telegramUserFromInitData(sign(fields, ['hash', 'signature'])), 42);
});

test('a tampered user id is rejected', () => {
    const initData = sign(baseFields(), ['hash']);
    const tampered = initData.replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":99'));
    assert.notEqual(tampered, initData, 'the test must actually change the payload');
    assert.equal(telegramUserFromInitData(tampered), null);
});

test('a payload signed with a different bot token is rejected', () => {
    const fields = baseFields();
    const checkString = Object.entries(fields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update('999:SOMEONE-ELSES-TOKEN').digest();
    const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
    assert.equal(telegramUserFromInitData(new URLSearchParams({ ...fields, hash }).toString()), null);
});

test('a stale payload is rejected', () => {
    const twoDaysAgo = String(Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60);
    const initData = sign(baseFields({ auth_date: twoDaysAgo }), ['hash']);
    assert.equal(telegramUserFromInitData(initData), null);
});

test('empty and malformed payloads are rejected without throwing', () => {
    assert.equal(telegramUserFromInitData(''), null);
    assert.equal(telegramUserFromInitData('hash=deadbeef'), null);
    assert.equal(telegramUserFromInitData('user=notjson&hash=deadbeef'), null);
});
