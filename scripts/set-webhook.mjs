#!/usr/bin/env node
// Points Telegram at the deployed webhook, or removes it again.
//
//   node scripts/set-webhook.mjs https://shilpo.vercel.app
//   node scripts/set-webhook.mjs --delete     (back to local long polling)
//   node scripts/set-webhook.mjs --info
//
// BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are read from bot/.env or the
// environment. The secret is echoed by Telegram in a header on every update,
// which is what stops anyone else from posting fake updates to the endpoint.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(file) {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!match || process.env[match[1]]) continue;
        process.env[match[1]] = match[2].replace(/^["'](.*)["']$/, '$1');
    }
}

loadEnvFile(path.join(projectRoot, 'bot', '.env'));

const token = (process.env.BOT_TOKEN || '').trim();
if (!token) {
    console.error('BOT_TOKEN is not set (put it in bot/.env or the environment).');
    process.exit(1);
}

async function callTelegram(method, body) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(`${method} failed: ${JSON.stringify(result)}`);
    return result.result;
}

const argument = process.argv[2];

if (argument === '--info') {
    console.log(JSON.stringify(await callTelegram('getWebhookInfo'), null, 2));
} else if (argument === '--delete') {
    await callTelegram('deleteWebhook', { drop_pending_updates: false });
    console.log('✅ Webhook removed — the bot can go back to long polling.');
} else if (argument) {
    const base = argument.replace(/\/+$/, '');
    if (!/^https:\/\//i.test(base)) {
        console.error('The base URL must be https.');
        process.exit(1);
    }
    const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
    if (!secret) {
        console.error('TELEGRAM_WEBHOOK_SECRET is not set — refusing to expose an unauthenticated webhook.');
        process.exit(1);
    }
    await callTelegram('setWebhook', {
        url: `${base}/api/telegram`,
        secret_token: secret,
        // Silpo lists arrive as photos, documents, text and button taps.
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
    });
    console.log(`✅ Webhook set to ${base}/api/telegram`);
    console.log(JSON.stringify(await callTelegram('getWebhookInfo'), null, 2));
} else {
    console.error('Usage: node scripts/set-webhook.mjs <https://base-url> | --delete | --info');
    process.exit(1);
}
