import { Markup, type Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { SilpoNotConnectedError } from '../silpo/auth';
import { formatPrice } from '../silpo/products';
import { SEARCH_PREFERENCES, type SearchPreference } from '../silpo/ranking';
import {
    getActiveItems,
    getList,
    setChatMessageId,
    type ListRecord,
} from '../lists/repository';
import { nextQuestion, questionForItem, runSearch, type PendingQuestion } from '../lists/flow';
import { escapeHtml, itemPreviewLine, pluralizeDetails, pluralizeItems, pluralizeProducts } from './format';
import { signAuthLink } from '../auth/link';
import { publicBaseUrl } from '../config';

export function webappUrl(): string {
    return publicBaseUrl();
}

export function pickerUrl(listId: string): string {
    return `${webappUrl()}/?list=${encodeURIComponent(listId)}`;
}

export function connectKeyboard(tgId: number) {
    return Markup.inlineKeyboard([
        [Markup.button.url('🔗 Підключити Кабінет Сільпо', signAuthLink(webappUrl(), tgId))],
    ]);
}

export const NEW_LIST_BUTTON = '📝 Новий список';
export const CART_BUTTON = '🛒 Мій кошик';
export const APP_BUTTON = '🍊 Мій список';

/**
 * The buttons that live by the input field.
 *
 * A single Mini App button there was the wrong thing: it opened an app to say
 * "you have no list", while the two actions a guest actually wants between
 * lists — start over, look in the cart — had no button at all. Starting a new
 * list has always been possible by simply sending a photo, but nothing said so.
 *
 * Telegram allows one reply markup per message, so this can only ride on
 * messages that carry no inline buttons of their own.
 */
export function mainKeyboard() {
    const rows = [[Markup.button.text(NEW_LIST_BUTTON), Markup.button.text(CART_BUTTON)]];
    if (webappUrl()) rows.push([Markup.button.webApp(APP_BUTTON, webappUrl())]);
    return Markup.keyboard(rows).resize().persistent();
}

export async function askToConnect(ctx: Context, tgId: number, reason: string): Promise<void> {
    await ctx.reply(
        `${reason}\n\nЦе займе <b>пів хвилини</b>. Сільпо покаже свою сторінку входу, ` +
        'а я отримаю доступ лише до каталогу, кошика й магазину, який ти вже обрав.',
        { parse_mode: 'HTML', ...connectKeyboard(tgId) }
    );
}

/** Shows exactly what was read, so a misread word is caught before the search. */
export async function sendRecognizedList(ctx: Context, list: ListRecord): Promise<void> {
    const items = await getActiveItems(list.listId);
    if (!items.length) {
        await ctx.reply(
            '🤔 <b>Не знайшла тут жодного товару</b>\n\n' +
            'Спробуй сфотографувати чіткіше або напиши позиції текстом — по одній у рядку.',
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
        ? `\n\n👇 Уточню <b>${pending === 1 ? 'одну' : pending} ${pluralizeDetails(pending)}</b> — і біжу шукати.`
        : '\n\n🔎 Шукаю ці товари в Сільпо…';

    await ctx.reply(
        `📝 <b>Прочитала твій список</b> — ${items.length} ${pluralizeItems(items.length)}\n\n${lines}${footer}`,
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

const PREFERENCE_LABELS: Record<SearchPreference, string> = {
    cheap: '💸 Найдешевше',
    promo: '🔥 За акцією',
    familiar: '⭐ Те, що я вже брав',
    premium: '👑 Найкраще',
};

export const PREFERENCE_CONFIRMATIONS: Record<SearchPreference, string> = {
    cheap: '💸 Шукаю <b>найвигідніші</b> варіанти',
    promo: '🔥 Шукаю те, що <b>зараз в акції</b>',
    familiar: '⭐ Шукаю <b>звичне</b> — те, що ти вже брав',
    premium: '👑 Шукаю <b>найкраще</b>, без економії',
};

function preferenceKeyboard(listId: string) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(PREFERENCE_LABELS.familiar, `pref:${listId}:familiar`),
            Markup.button.callback(PREFERENCE_LABELS.cheap, `pref:${listId}:cheap`),
        ],
        [
            Markup.button.callback(PREFERENCE_LABELS.promo, `pref:${listId}:promo`),
            Markup.button.callback(PREFERENCE_LABELS.premium, `pref:${listId}:premium`),
        ],
    ]);
}

export function isKnownPreference(value: string): value is SearchPreference {
    return (SEARCH_PREFERENCES as string[]).includes(value);
}

/**
 * Asks the next open question, then the one list-level question, and only then
 * searches. Asking what matters *before* searching is what keeps the first
 * card relevant instead of arbitrary.
 */
export async function advanceConversation(ctx: Context, tgId: number, listId: string): Promise<void> {
    const question = await nextQuestion(listId);
    if (question) {
        const message = await ctx.reply(
            `❓ <b>${escapeHtml(question.question)}</b>`,
            { parse_mode: 'HTML', ...questionKeyboard(question) }
        );
        await setChatMessageId(listId, message.message_id);
        return;
    }

    const list = await getList(listId);
    if (list && !list.preference) {
        await ctx.reply(
            '🎯 <b>Що для тебе важливіше?</b>\n\n' +
            'Під кожну позицію знайдеться десяток варіантів — підберу під твій смак.',
            { parse_mode: 'HTML', ...preferenceKeyboard(listId) }
        );
        return;
    }

    await searchAndInvite(ctx, tgId, listId, list?.preference ?? 'familiar');
}

/** Runs the catalogue search and hands the guest over to the Mini App picker. */
export async function searchAndInvite(
    ctx: Context,
    tgId: number,
    listId: string,
    preference: SearchPreference
): Promise<void> {
    const progress = await ctx.reply('🔎 Шукаю у твоєму магазині Сільпо…');
    try {
        const { context, found, missing } = await runSearch(tgId, listId, preference);
        await ctx.telegram.deleteMessage(progress.chat.id, progress.message_id).catch(() => undefined);

        if (!found.length) {
            await ctx.reply(
                '😞 <b>Нічого зі списку не знайшлося</b>\n\n' +
                `${escapeHtml(context.storeLabel)}\n\n` +
                'Відкрий список і зміни магазин угорі екрана — я перешукаю все за його цінами.',
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.webApp('📍 Змінити магазин', pickerUrl(listId))],
                    ]),
                }
            );
            return;
        }

        const estimate = found.reduce((sum, item) => {
            const product = item.candidates[0];
            return sum + (product ? product.price * (Number(item.quantity) || 1) : 0);
        }, 0);

        const lines = [
            `✅ <b>Знайшла ${found.length} ${pluralizeItems(found.length)}</b>`,
            `📍 ${escapeHtml(context.storeLabel)}`,
            '',
            `💰 Орієнтовно: <b>${formatPrice(estimate)}</b> — кількість підкрутиш у застосунку`,
        ];
        if (context.deliveryPrice !== null) {
            const free = context.freeDeliveryFrom
                ? ` · безкоштовно від <b>${formatPrice(context.freeDeliveryFrom)}</b>`
                : '';
            lines.push(`🚚 Доставка: <b>${formatPrice(context.deliveryPrice)}</b>${free}`);
        }
        if (context.orderMinimum !== null) {
            lines.push(`📦 Мінімальне замовлення: <b>${formatPrice(context.orderMinimum)}</b>`);
        }
        if (missing.length) {
            lines.push('', `⚠️ Не знайшла: <b>${missing.map(item => escapeHtml(item.query)).join(', ')}</b>`);
        }
        lines.push('', '👇 Обери конкретні товари — я підібрала варіанти з фото та цінами.');

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
        await ctx.reply('😞 Сільпо зараз не відповідає. Спробуй за хвилину — список я зберегла.');
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

    const proxy = {
        telegram: bot.telegram,
        reply: (text: string, extra?: any) => bot.telegram.sendMessage(tgId, text, extra),
        chat: { id: tgId },
    } as unknown as Context;

    await advanceConversation(proxy, tgId, listId);
}

export function summarizeCartResult(added: number, total: number, mode: 'append' | 'replace'): string {
    const verb = mode === 'replace' ? 'Замінила кошик' : 'Додала в кошик';
    return `🛒 <b>${verb}</b>: ${added} ${pluralizeProducts(added)} на <b>${formatPrice(total)}</b>`;
}
