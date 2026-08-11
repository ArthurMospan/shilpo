// Vercel entry point. One catch-all function serves every /api/* route: the
// Telegram webhook, the OAuth handshake and the Mini App API. Everything else
// is static and comes straight from the CDN.
//
// The module body runs once per instance and is reused across invocations, so
// the bot and the Express app are built here rather than per request.

import { createBot } from '../bot/src/bot/index';
import { createApp } from '../bot/src/server/app';

const bot = createBot();
const app = createApp(bot);

export default app;
