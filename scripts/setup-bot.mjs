#!/usr/bin/env node
// Configures the bot's public presentation through the Bot API: the text shown
// in an empty chat, the profile blurb, the command list and the menu button.
//
//   node scripts/setup-bot.mjs
//
// Everything here is idempotent, so re-running after a copy change is safe.
// Only the profile photo still has to be set through @BotFather.

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

const webappUrl = (() => {
    const raw = (process.env.WEBAPP_URL || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
})();

async function call(method, body) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result)}`);
    return result.result;
}

// Shown in an empty chat, above the Start button. Max 512 characters.
const DESCRIPTION = `Перетворюю звичайний список покупок на готовий кошик Сільпо 🍊

Надішли фото списку — хоч рукописного на клаптику паперу — або просто напиши товари текстом.

Я прочитаю список, уточню незрозуміле, знайду кожен товар у твоєму магазині Сільпо з реальними цінами й покажу варіанти з фото. Обереш потрібні — і все опиниться в кошику.`;

// Shown on the bot's profile card. Max 120 characters.
const SHORT_DESCRIPTION = 'Фото списку покупок → готовий кошик Сільпо з реальними цінами твого магазину 🍊';

const COMMANDS = [
    { command: 'new', description: '📝 Почати новий список' },
    { command: 'cart', description: '🛒 Мій кошик Сільпо' },
    { command: 'connect', description: '🔗 Підключити Кабінет Сільпо' },
    { command: 'disconnect', description: '🔓 Відключити акаунт' },
    { command: 'help', description: '❓ Як це працює' },
];

async function main() {
    const me = await call('getMe');
    console.log(`Configuring @${me.username} (${me.first_name})`);

    if (DESCRIPTION.length > 512) throw new Error(`Description is ${DESCRIPTION.length} characters, max is 512`);
    if (SHORT_DESCRIPTION.length > 120) throw new Error(`Short description is ${SHORT_DESCRIPTION.length}, max is 120`);

    await call('setMyDescription', { description: DESCRIPTION });
    console.log('✅ Description set');

    await call('setMyShortDescription', { short_description: SHORT_DESCRIPTION });
    console.log('✅ Short description set');

    await call('setMyCommands', { commands: COMMANDS });
    console.log(`✅ ${COMMANDS.length} commands set`);

    if (webappUrl) {
        await call('setChatMenuButton', {
            menu_button: { type: 'web_app', text: '🍊 Шільпо', web_app: { url: webappUrl } },
        });
        console.log(`✅ Menu button opens ${webappUrl}`);
    } else {
        console.warn('⚠️ WEBAPP_URL is not set — leaving the menu button alone');
    }

    console.log('\nVerifying:');
    console.log(JSON.stringify({
        description: (await call('getMyDescription')).description,
        shortDescription: (await call('getMyShortDescription')).short_description,
        commands: (await call('getMyCommands')).map(entry => `/${entry.command}`).join(' '),
        menuButton: (await call('getChatMenuButton')).type,
    }, null, 2));
}

main().catch(error => {
    console.error('❌', error.message);
    process.exit(1);
});
