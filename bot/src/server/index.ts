import path from 'path';
import express from 'express';
import type { Telegraf } from 'telegraf';
import { createApp } from './app';

export { createApp, WEBHOOK_PATH, webhookSecret } from './app';

/**
 * Wraps the API with static hosting for the Mini App. On Vercel the CDN serves
 * those files directly, so this exists only for a long-lived process: local
 * development and any container deploy.
 */
export function createStandaloneServer(bot: Telegraf) {
    const app = createApp(bot);
    const webappDist = path.resolve(__dirname, '../../../webapp/dist');
    app.use(express.static(webappDist));
    app.get(/.*/, (req, res, next) => {
        if (req.path.startsWith('/api') || req.path === '/health') return next();
        res.sendFile(path.join(webappDist, 'index.html'));
    });
    return app;
}

export function startServer(bot: Telegraf, port = Number(process.env.PORT) || 3000): void {
    const host = process.env.SERVER_HOST || '0.0.0.0';
    createStandaloneServer(bot).listen(port, host, () => {
        console.log(`✅ API and Mini App listening on ${host}:${port}`);
    });
}
