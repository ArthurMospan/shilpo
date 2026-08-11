import crypto from 'crypto';

// The OAuth handshake starts from a button inside a Telegram chat, where no
// signed Mini App initData exists yet. A short-lived HMAC over the Telegram id
// keeps that entry point from being used to attach someone else's Silpo
// account to an attacker-chosen chat.

const LINK_TTL_SECONDS = 15 * 60;

export function botToken(): string {
    return (process.env.BOT_TOKEN || '').trim().replace(/^("|')(.*)\1$/, '$2').trim();
}

function signature(payload: string): string {
    return crypto.createHmac('sha256', botToken()).update(payload).digest('base64url');
}

export function signAuthLink(baseUrl: string, tgId: number): string {
    const expiresAt = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
    const payload = `${tgId}.${expiresAt}`;
    const url = new URL('/auth/start', baseUrl);
    url.searchParams.set('tg_id', String(tgId));
    url.searchParams.set('exp', String(expiresAt));
    url.searchParams.set('sig', signature(payload));
    return url.toString();
}

export function verifyAuthLink(tgId: number, expiresAt: number, providedSignature: string): boolean {
    if (!botToken() || !tgId || !expiresAt || !providedSignature) return false;
    if (expiresAt <= Math.floor(Date.now() / 1000)) return false;

    const expected = signature(`${tgId}.${expiresAt}`);
    if (expected.length !== providedSignature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(providedSignature));
}
