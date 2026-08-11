import { Markup, type Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { SilpoNotConnectedError } from '../silpo/auth';
import { formatPrice } from '../silpo/products';
import {
    getActiveItems,
    getList,
    setChatMessageId,
    type ListRecord,
} from '../lists/repository';
import { nextQuestion, questionForItem, runSearch, type PendingQuestion } from '../lists/flow';
import { escapeHtml, itemPreviewLine, pluralizeDetails, pluralizeItems, pluralizeProducts } from './format';
import { signAuthLink } from '../auth/link';

export function webappUrl(): string {
    return (process.env.WEBAPP_URL || '').trim().replace(/\/+$/, '');
}

export function pickerUrl(listId: string): string {
    return `${webappUrl()}/?list=${encodeURIComponent(listId)}`;
}

export function connectKeyboard(tgId: number) {
    return Markup.inlineKeyboard([
        [Markup.button.url('🔗 Підключити Кабінет Сільпо', signAuthLink(webappUrl(), tgId))],
    ]);
}

export async function askToConnect(ctx: Context, tgId: number, reason: string): Promise<void> {
    await ctx.reply(
        `${reason}\n\nПідключення займає пів хвилини — Сільпо покаже свою сторінку входу, ` +
        'а я отримаю доступ лише до каталогу, кошика й магазину, який ти вже обрав.',
        { parse_mode: 'HTML', ...connectKeyboard(tgId) }
    );
}

/** Renders the recognized list so the guest can see exactly what was read. */
export async function sendRecognizedList(ctx: Context, list: ListRecord): Promise<void> {
    const items = await getActiveItems(list.listId);
    if (!items.length) {
        await ctx.reply(
            'Не змогла розібрати цей список 🤔\n\nНадішли фото чіткіше або напиши позиції текстом — по одній у рядку.',
            { parse_mode: 'HTML' }
        );
        return;
    }

    // Count every question the guest will actually be asked, including the
    // missing-quantity ones — promising "one detail" and then asking four
    // reads as the bot losing track.
    const pending = items.filter(item => questionForItem(item) !== null).length;
    const lines = items.map(itemPreviewLine).join('\n');
    const footer = pending
        ? `\n\nУточню ${pending === 1 ? 'одну' : pending} ${pluralizeDetails(pending)} — і одразу шукаю в Сільпо.`
        : '\n\nШукаю ці товари в Сільпо…';

    await ctx.reply(
        `📝 <b>Ось що я прочитала</b> — ${items.length} ${pluralizeItems(items.length)}:\n\n${lines}${footer}`,
        { parse_mode: 'HTML' }
    );
}

function questionKeyboard(question: PendingQuestion) {
    const optionButtons = question.options.map((option, index) =>
        Markup.button.callback(option, `ans:${question.item.itemId}:${index}`));

    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    // Short answers such as 1 / 2 / 3 read better on one row.
    if (optionButtons.length <= 3 && question.options.every(option => option.length <= 12)) {
        rows.push(optionButtons);
    } else {
        optionButtons.forEach(button => rows.push([button]));
    }
    rows.push([
        Markup.button.callback('✏️ Інше', `other:${question.item.itemId}`),
        Markup.button.callback('🚫 Не треба', `drop:${question.item.itemId}`),
    ]);
    return Markup.inlineKeyboard(rows);
}

/**
 * Asks the next open question, or moves the list to the search step when
 * nothing is left to clarify.
 */
export async function advanceConversation(ctx: Context, tgId: number, listId: string): Promise<void> {
    const question = await nextQuestion(listId);
    if (question) {
        const hint = question.kind === 'quantity'
            ? '\n<i>Можна написати свою кількість — наприклад «2 кг».</i>'
            : '';
        const message = await ctx.reply(
            `❓ ${escapeHtml(question.question)}${hint}`,
            { parse_mode: 'HTML', ...questionKeyboard(question) }
        );
        await setChatMessageId(listId, message.message_id);
        return;
    }
    await searchAndInvite(ctx, tgId, listId);
}

/** Runs the catalogue search and hands the guest over to the Mini App picker. */
export async function searchAndInvite(ctx: Context, tgId: number, listId: string): Promise<void> {
    const progress = await ctx.reply('🔎 Шукаю товари у твоєму магазині Сільпо…');
    try {
        const { context, found, missing } = await runSearch(tgId, listId);
        await ctx.telegram.deleteMessage(progress.chat.id, progress.message_id).catch(() => undefined);

        if (!found.length) {
            await ctx.reply(
                'На жаль, нічого зі списку не знайшлося у твоєму магазині 😞\n\n' +
                `Магазин: <b>${escapeHtml(context.storeLabel)}</b>\n` +
                'Спробуй змінити магазин або спосіб доставки в застосунку Сільпо й надішли список ще раз.',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const estimate = found.reduce((sum, item) => {
            const product = item.candidates[0];
            return sum + (product ? product.price * (Number(item.quantity) || 1) : 0);
        }, 0);

        const lines = [
            `✅ Знайшла <b>${found.length}</b> ${pluralizeItems(found.length)} у магазині <b>${escapeHtml(context.storeLabel)}</b>`,
            '',
            `💰 Орієнтовно: <b>${formatPrice(estimate)}</b>`,
        ];
        if (context.deliveryPrice !== null) {
            const free = context.freeDeliveryFrom ? ` · безкоштовно від ${formatPrice(context.freeDeliveryFrom)}` : '';
            lines.push(`🚚 Доставка: <b>${formatPrice(context.deliveryPrice)}</b>${free}`);
        }
        if (context.orderMinimum !== null) {
            lines.push(`📦 Мінімальне замовлення: <b>${formatPrice(context.orderMinimum)}</b>`);
        }
        if (missing.length) {
            const names = missing.map(item => escapeHtml(item.query)).join(', ');
            lines.push('', `⚠️ Не знайшла: ${names}`);
        }
        lines.push('', 'Тепер обери конкретні товари — я підібрала варіанти з фото та цінами.');

        await ctx.reply(lines.join('\n'), {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp(`🛒 Обрати товари (${found.length})`, pickerUrl(listId))],
            ]),
        });
    } catch (error) {
        await ctx.telegram.deleteMessage(progress.chat.id, progress.message_id).catch(() => undefined);
        if (error instanceof SilpoNotConnectedError) {
            await askToConnect(ctx, tgId, '🔐 Щоб шукати товари й наповнювати кошик, потрібен доступ до твого Кабінету Сільпо.');
            return;
        }
        console.error('[Conversation] Search failed:', error);
        await ctx.reply('Сільпо зараз не відповідає 😞 Спробуй ще раз за хвилину — список я зберегла.');
    }
}

/**
 * Resumes a list that was waiting for the guest to connect their Silpo
 * account. Called from the OAuth callback, so it talks to Telegram directly
 * instead of through a chat context.
 */
export async function resumePendingList(bot: Telegraf, tgId: number, listId: string): Promise<void> {
    const list = await getList(listId);
    if (!list || list.stage === 'done') return;

    const chat = { chat: { id: tgId } };
    const proxy = {
        telegram: bot.telegram,
        reply: (text: string, extra?: any) => bot.telegram.sendMessage(tgId, text, extra),
        ...chat,
    } as unknown as Context;

    await advanceConversation(proxy, tgId, listId);
}

export function summarizeCartResult(added: number, total: number, mode: 'append' | 'replace'): string {
    const verb = mode === 'replace' ? 'Замінила кошик' : 'Додала в кошик';
    return `🛒 <b>${verb}</b>: ${added} ${pluralizeProducts(added)} на <b>${formatPrice(total)}</b>`;
}
