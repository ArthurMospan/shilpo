import dotenv from 'dotenv';
import { createBot } from './bot/index';
import { startServer } from './server/index';
import { geminiConfigured } from './ai/gemini';
import { dbReady } from './db/index';

dotenv.config();

async function main(): Promise<void> {
    const webappUrl = (process.env.WEBAPP_URL || '').trim();
    if (!/^https:\/\//i.test(webappUrl)) {
        console.error('❌ WEBAPP_URL must be a public HTTPS address — Telegram refuses to open a Mini App otherwise.');
        process.exit(1);
    }
    if (!geminiConfigured()) {
        console.error('❌ GEMINI_API_KEY is required (one key, or several separated by commas).');
        process.exit(1);
    }

    await dbReady;
    const bot = createBot();
    startServer(bot);

    let stopping = false;
    let retryAttempt = 0;
    let retryTimer: NodeJS.Timeout | undefined;

    const launch = async (): Promise<void> => {
        try {
            // launch() stays pending for the whole polling session and only
            // settles on stop or failure, so the "started" log belongs in the
            // onLaunch callback rather than after the await.
            await bot.launch({ dropPendingUpdates: true }, () => {
                retryAttempt = 0;
                console.log('✅ Шільпо is live on Telegram');
            });
        } catch (error) {
            if (stopping) return;
            // A rolling deploy can briefly overlap two releases, and Telegram
            // allows only one long-polling session per bot. Retrying keeps the
            // HTTP server (and the Mini App) alive through the overlap.
            retryAttempt += 1;
            const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retryAttempt, 5));
            console.error(`Telegram polling failed; retrying in ${delay / 1000}s`, error);
            retryTimer = setTimeout(() => void launch(), delay);
        }
    };
    void launch();

    const stop = (signal: 'SIGINT' | 'SIGTERM') => {
        stopping = true;
        if (retryTimer) clearTimeout(retryTimer);
        bot.stop(signal);
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
}

void main();
