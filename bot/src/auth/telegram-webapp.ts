import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { botToken } from './link';

// Telegram signs the Mini App launch payload with the bot token. Verifying it
// server-side is the only thing that ties an API call to a real Telegram user;
// a tg_id in the query string alone proves nothing.

const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            tgId?: number;
        }
    }
}

function initDataFromRequest(req: Request): string {
    const header = req.headers['x-telegram-init-data'];
    if (typeof header === 'string' && header.trim()) return header.trim();
    if (Array.isArray(header) && header[0]?.trim()) return header[0].trim();
    const queryValue = req.query.init_data;
    return typeof queryValue === 'string' ? queryValue.trim() : '';
}

function dataCheckString(params: URLSearchParams, omit: string[]): string {
    return [...params.entries()]
        .filter(([key]) => !omit.includes(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
}

function hashMatches(candidate: string, receivedHash: string): boolean {
    if (candidate.length !== receivedHash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(receivedHash));
}

export function telegramUserFromInitData(initData: string): number | null {
    const token = botToken();
    if (!token || !initData) return null;

    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return null;

    // Telegram specifies the literal string "WebAppData" as the HMAC key and
    // the bot token as the message when deriving the secret.
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const hashFor = (omit: string[]): string =>
        crypto.createHmac('sha256', secretKey).update(dataCheckString(params, omit)).digest('hex');

    // Telegram's docs are ambiguous about whether the newer Ed25519 `signature`
    // field belongs in the data-check-string for bot-token validation, and
    // clients differ. Accepting either construction costs microseconds and
    // makes the check correct under both readings — the secret still has to be
    // the bot token, so this weakens nothing.
    const accepted = hashMatches(hashFor(['hash']), receivedHash)
        || (params.has('signature') && hashMatches(hashFor(['hash', 'signature']), receivedHash));
    if (!accepted) return null;

    const authDate = Number(params.get('auth_date'));
    if (Number.isFinite(authDate) && Date.now() / 1000 - authDate > MAX_INIT_DATA_AGE_SECONDS) return null;

    try {
        const user = JSON.parse(params.get('user') || '{}');
        const id = Number(user?.id);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
    } catch {
        return null;
    }
}

export function requireTelegramUser(req: Request, res: Response, next: NextFunction): void {
    const initData = initDataFromRequest(req);
    const tgId = telegramUserFromInitData(initData);
    if (!tgId) {
        // A local dev session has no Telegram host to sign the payload.
        if (process.env.NODE_ENV !== 'production' && process.env.DEV_TG_ID) {
            req.tgId = Number(process.env.DEV_TG_ID);
            next();
            return;
        }
        logRejectedIdentity(req, initData);
        // A distinct code matters: the Mini App must not tell the guest their
        // Silpo account is disconnected when the real problem is the Telegram
        // launch payload.
        res.status(401).json({ error: 'Invalid Telegram identity', code: 'telegram_identity' });
        return;
    }
    req.tgId = tgId;
    next();
}

/** Logs why a launch payload was refused, without ever logging the payload itself. */
function logRejectedIdentity(req: Request, initData: string): void {
    let fields: string[] = [];
    try {
        fields = [...new URLSearchParams(initData).keys()];
    } catch {
        // A malformed payload has no fields worth reporting.
    }
    console.warn('[Auth] Telegram identity rejected', {
        path: req.path,
        hasInitData: Boolean(initData),
        initDataLength: initData.length,
        fields,
        hasBotToken: Boolean(botToken()),
    });
}
