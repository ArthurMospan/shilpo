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

export function telegramUserFromInitData(initData: string): number | null {
    const token = botToken();
    if (!token || !initData) return null;

    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return null;
    params.delete('hash');
    params.delete('signature');

    const dataCheckString = [...params.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
    // Telegram specifies the literal string "WebAppData" as the HMAC key and
    // the bot token as the message when deriving the secret.
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (calculatedHash.length !== receivedHash.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(calculatedHash), Buffer.from(receivedHash))) return null;

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
    const tgId = telegramUserFromInitData(initDataFromRequest(req));
    if (!tgId) {
        // A local dev session has no Telegram host to sign the payload.
        if (process.env.NODE_ENV !== 'production' && process.env.DEV_TG_ID) {
            req.tgId = Number(process.env.DEV_TG_ID);
            next();
            return;
        }
        res.status(401).json({ error: 'Invalid Telegram identity' });
        return;
    }
    req.tgId = tgId;
    next();
}
