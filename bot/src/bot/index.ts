import { Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Context } from 'telegraf';
import { GeminiUnavailableError } from '../ai/gemini';
import { parseListFromImage, parseListFromText, type ParsedItem } from '../ai/list-parser';
import { isConnected, disconnect, withSilpoToken, SilpoNotConnectedError } from '../silpo/auth';
import { getStoreContext } from '../silpo/store';
import { getCartSummary, SILPO_BASKET_URL } from '../silpo/cart';
import { formatPrice } from '../silpo/products';
import {
    abandonActiveLists,
    createList,
    ensureUser,
    getActiveList,
    getItem,
    setChatMessageId,
} from '../lists/repository';
import { nextQuestion, questionForItem } from '../lists/flow';
import { applyAnswer } from '../lists/answers';
import {
    advanceConversation,
    askToConnect,
    connectKeyboard,
    sendRecognizedList,
    webappUrl,
} from './conversation';
import { escapeHtml, pluralizeProducts } from './format';

const MAX_LIST_TEXT_LENGTH = 3000;

const WELCOME = `Привіт! Я <b>Шільпо</b> 🍊

Надішли мені <b>фото списку покупок</b> — хоч рукописного на клаптику паперу — або просто напиши товари текстом.

Далі я:
1️⃣ прочитаю список і уточню деталі, якщо щось незрозуміло;
2️⃣ знайду кожен товар у <b>твоєму</b> магазині Сільпо з актуальними цінами;
3️⃣ покажу варіанти з фото, щоб ти обрав саме те, що треба;
4️⃣ складу все в кошик Сільпо — і ти одразу переходиш до оформлення.

Спробуй просто сфотографувати свій список 📸`;

const HELP = `<b>Як користуватися Шільпо</b>

📸 <b>Фото</b> — сфотографуй список покупок, навіть від руки.
✍️ <b>Текст</b> — напиши товари, кожен з нового рядка.

Команди:
/new — почати новий список
/cart — показати мій кошик Сільпо
/connect — підключити Кабінет Сільпо
/disconnect — відключити акаунт
/help — ця довідка`;

function tgIdOf(ctx: Context): number {
    return Number(ctx.from?.id || 0);
}

/**
 * Telegraf's `message(...)` filters narrow to an intersection that drops
 * `caption`, even though photo and document messages carry one. Reading it
 * defensively keeps the caption without depending on that narrowing.
 */
function captionOf(message: unknown): string {
    if (message && typeof message === 'object' && 'caption' in message) {
        const caption = (message as { caption?: unknown }).caption;
        if (typeof caption === 'string') return caption;
    }
    return '';
}

async function downloadPhotoAsBase64(ctx: Context, fileId: string): Promise<string> {
    const link = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(link.href);
    if (!response.ok) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer()).toString('base64');
}

/** Shared entry point for both a photo and a typed list. */
async function startList(
    ctx: Context,
    tgId: number,
    source: 'photo' | 'text',
    rawInput: string,
    parse: () => Promise<ParsedItem[]>
): Promise<void> {
    await ensureUser(tgId, ctx.from?.first_name);
    // A new list supersedes whatever was half-finished, so stale questions
    // never get mixed into the fresh one.
    await abandonActiveLists(tgId);

    const thinking = await ctx.reply(source === 'photo' ? '📸 Читаю твій список…' : '📝 Розбираю список…');
    let items: ParsedItem[];
    try {
        items = await parse();
    } catch (error) {
        await ctx.telegram.deleteMessage(thinking.chat.id, thinking.message_id).catch(() => undefined);
        if (error instanceof GeminiUnavailableError) {
            console.error('[Bot] Gemini unavailable:', error.message);
            await ctx.reply('Розпізнавання зараз недоступне 😞 Спробуй, будь ласка, за хвилину.');
            return;
        }
        console.error('[Bot] List parsing failed:', error);
        await ctx.reply('Не вдалося прочитати список. Спробуй ще раз або надішли текстом.');
        return;
    }
    await ctx.telegram.deleteMessage(thinking.chat.id, thinking.message_id).catch(() => undefined);

    if (!items.length) {
        await ctx.reply(
            'Не знайшла тут жодного товару 🤔\n\nНадішли фото чіткіше або напиши список текстом — по товару в рядку.'
        );
        return;
    }

    const list = await createList(tgId, source, rawInput, items);
    await sendRecognizedList(ctx, list);

    if (!(await isConnected(tgId))) {
        await askToConnect(ctx, tgId, '🔐 Щоб знайти ці товари з реальними цінами, підключи свій Кабінет Сільпо.');
        return;
    }
    await advanceConversation(ctx, tgId, list.listId);
}

/** Replaces an answered question with its result so the chat stays readable. */
async function markQuestionAnswered(ctx: Context, summary: string): Promise<void> {
    try {
        await ctx.editMessageText(summary, { parse_mode: 'HTML' });
    } catch {
        // The message may be too old to edit; the follow-up still carries the state.
        await ctx.reply(summary, { parse_mode: 'HTML' });
    }
}

async function processAnswer(ctx: Context, tgId: number, itemId: string, answer: string): Promise<void> {
    const item = await getItem(itemId);
    if (!item) {
        await ctx.reply('Ця позиція вже неактуальна. Надішли новий список — і почнемо спочатку.');
        return;
    }
    const question = questionForItem(item);
    if (!question) {
        await advanceConversation(ctx, tgId, item.listId);
        return;
    }

    const outcome = await applyAnswer(question, answer);
    await markQuestionAnswered(ctx, outcome.summary);
    await advanceConversation(ctx, tgId, item.listId);
}

export function createBot(): Telegraf {
    const token = (process.env.BOT_TOKEN || '').trim().replace(/^("|')(.*)\1$/, '$2').trim();
    if (!token) throw new Error('BOT_TOKEN is required');
    const bot = new Telegraf(token);

    bot.start(async (ctx) => {
        const tgId = tgIdOf(ctx);
        await ensureUser(tgId, ctx.from?.first_name);
        const connected = await isConnected(tgId);
        await ctx.reply(WELCOME, {
            parse_mode: 'HTML',
            ...(connected ? {} : connectKeyboard(tgId)),
        });
        if (webappUrl()) {
            await ctx.setChatMenuButton({
                type: 'web_app',
                text: '🛒 Мій список',
                web_app: { url: webappUrl() },
            }).catch(() => undefined);
        }
    });

    bot.help(ctx => ctx.reply(HELP, { parse_mode: 'HTML' }));

    bot.command('connect', async (ctx) => {
        const tgId = tgIdOf(ctx);
        await ensureUser(tgId, ctx.from?.first_name);
        if (await isConnected(tgId)) {
            await ctx.reply('Кабінет Сільпо вже підключено ✅\n\nНадсилай список — і я почну.');
            return;
        }
        await askToConnect(ctx, tgId, '🔗 Підключимо твій Кабінет Сільпо.');
    });

    bot.command('disconnect', async (ctx) => {
        await disconnect(tgIdOf(ctx));
        await ctx.reply('Акаунт Сільпо відключено. Можеш підключити знову командою /connect.');
    });

    bot.command('new', async (ctx) => {
        await abandonActiveLists(tgIdOf(ctx));
        await ctx.reply('Готова до нового списку 📝\n\nНадсилай фото або пиши товари текстом.');
    });

    bot.command('cart', async (ctx) => {
        const tgId = tgIdOf(ctx);
        try {
            const summary = await withSilpoToken(tgId, async (token) => {
                const context = await getStoreContext(token);
                const cart = await getCartSummary(token, context.shoppingCartId);
                return { context, cart };
            });
            if (summary.cart.isEmpty) {
                await ctx.reply('Твій кошик Сільпо порожній 🛒\n\nНадішли список — і я його наповню.');
                return;
            }
            const lines = summary.cart.lines
                .slice(0, 20)
                .map(line => `• ${escapeHtml(line.title)} — ${line.quantity} × ${formatPrice(line.price)}`);
            const more = summary.cart.lines.length > 20 ? `\n…і ще ${summary.cart.lines.length - 20}` : '';
            await ctx.reply(
                `🛒 <b>У кошику ${summary.cart.itemCount} ${pluralizeProducts(summary.cart.itemCount)}</b>\n` +
                `Магазин: ${escapeHtml(summary.context.storeLabel)}\n\n${lines.join('\n')}${more}\n\n` +
                `Разом: <b>${formatPrice(summary.cart.total)}</b>`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([[Markup.button.url('Перейти до кошика', SILPO_BASKET_URL)]]),
                }
            );
        } catch (error) {
            if (error instanceof SilpoNotConnectedError) {
                await askToConnect(ctx, tgId, '🔐 Спочатку підключи Кабінет Сільпо.');
                return;
            }
            console.error('[Bot] Cart command failed:', error);
            await ctx.reply('Не вдалося отримати кошик. Спробуй ще раз трохи пізніше.');
        }
    });

    bot.on(message('photo'), async (ctx) => {
        const tgId = tgIdOf(ctx);
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        await startList(ctx, tgId, 'photo', captionOf(ctx.message), async () => {
            const base64 = await downloadPhotoAsBase64(ctx, largest.file_id);
            return parseListFromImage(base64, 'image/jpeg');
        });
    });

    // Some guests send the photo as a file to keep full resolution.
    bot.on(message('document'), async (ctx) => {
        const document = ctx.message.document;
        const mimeType = document.mime_type || '';
        if (!mimeType.startsWith('image/')) {
            await ctx.reply('Я розумію фото списку або текст. Надішли, будь ласка, зображення.');
            return;
        }
        const tgId = tgIdOf(ctx);
        await startList(ctx, tgId, 'photo', captionOf(ctx.message), async () => {
            const base64 = await downloadPhotoAsBase64(ctx, document.file_id);
            return parseListFromImage(base64, mimeType);
        });
    });

    bot.on(message('text'), async (ctx) => {
        const tgId = tgIdOf(ctx);
        const text = ctx.message.text.trim();
        if (!text) return;

        // While a question is open, free text is the answer to it — unless the
        // guest clearly pasted a whole new list.
        const active = await getActiveList(tgId);
        const looksLikeNewList = text.split('\n').filter(line => line.trim()).length >= 3;
        if (active && !looksLikeNewList) {
            const question = await nextQuestion(active.listId);
            if (question) {
                await processAnswer(ctx, tgId, question.item.itemId, text);
                return;
            }
        }

        if (text.length > MAX_LIST_TEXT_LENGTH) {
            await ctx.reply('Список задовгий 😅 Надішли, будь ласка, частинами — до 3000 символів.');
            return;
        }
        await startList(ctx, tgId, 'text', text, () => parseListFromText(text));
    });

    bot.action(/^ans:([A-Za-z0-9_-]{4,32}):(\d{1,2})$/, async (ctx) => {
        const itemId = ctx.match[1];
        const optionIndex = Number(ctx.match[2]);
        const item = await getItem(itemId);
        const question = item ? questionForItem(item) : null;
        if (!question) {
            await ctx.answerCbQuery('Ця відповідь уже неактуальна');
            return;
        }
        const answer = question.options[optionIndex];
        if (!answer) {
            await ctx.answerCbQuery('Не впізнала цей варіант');
            return;
        }
        await ctx.answerCbQuery();
        await processAnswer(ctx, tgIdOf(ctx), itemId, answer);
    });

    bot.action(/^other:([A-Za-z0-9_-]{4,32})$/, async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply('Напиши свій варіант повідомленням — я врахую 👇');
    });

    bot.action(/^drop:([A-Za-z0-9_-]{4,32})$/, async (ctx) => {
        const itemId = ctx.match[1];
        const item = await getItem(itemId);
        if (!item) {
            await ctx.answerCbQuery('Ця позиція вже неактуальна');
            return;
        }
        await ctx.answerCbQuery('Прибрала');
        await processAnswer(ctx, tgIdOf(ctx), itemId, 'не треба');
    });

    bot.catch((error, ctx) => {
        console.error(`[Bot] Unhandled error for update ${ctx.updateType}:`, error);
    });

    return bot;
}

export async function clearActiveQuestionMessage(listId: string): Promise<void> {
    await setChatMessageId(listId, null);
}
