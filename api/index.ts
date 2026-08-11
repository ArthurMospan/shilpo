// Vercel entry point. One function serves every /api/* route: the Telegram
// webhook, the OAuth handshake and the Mini App API. Everything else is static
// and comes straight from the CDN.
//
// Why a plain filename plus a rewrite rather than a catch-all `[...path].ts`:
// in a zero-config project a catch-all filename compiles but produces no
// route, so every request fell through to the SPA fallback. The rewrite in
// vercel.json sends /api/* here while leaving the original path and query
// string on req.url, which is what lets a single Express app keep matching its
// own routes — OAuth callback parameters included.
//
// The module body runs once per instance and is reused across invocations, so
// the bot and the app are built here rather than per request.

import { createBot } from '../bot/src/bot/index';
import { createApp } from '../bot/src/server/app';

const bot = createBot();
const app = createApp(bot);

export default app;
