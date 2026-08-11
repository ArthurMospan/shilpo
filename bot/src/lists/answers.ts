import db from '../db/index';
import { refineItemWithAnswer } from '../ai/list-parser';
import { clearClarification, updateItem } from './repository';
import { isAffirmative, isNegative, isRefusal, itemLabel as label, quantityFromAnswer } from './answer-parsing';
import type { PendingQuestion } from './flow';

export interface AnswerOutcome {
    /** Short confirmation shown in place of the answered question. */
    summary: string;
    dropped: boolean;
    /** A follow-up question replaced the answered one. */
    askedAgain: boolean;
}

async function setClarification(itemId: string, question: string, options: string[]): Promise<void> {
    await db.prepare('UPDATE list_items SET clarification = ? WHERE item_id = ?')
        .run(JSON.stringify({ question, options }), itemId);
}

/**
 * Folds the guest's reply into a list line. Plain answers are handled locally
 * so a tap on "2" never waits on a model round trip; anything conversational
 * goes to Gemini.
 */
export async function applyAnswer(question: PendingQuestion, answer: string): Promise<AnswerOutcome> {
    const item = question.item;
    const trimmed = answer.trim();

    if (isRefusal(trimmed)) {
        await updateItem(item.itemId, { dropped: true, needsQuantity: false });
        await clearClarification(item.itemId);
        return { summary: `🚫 ${label(item)} — прибрала зі списку`, dropped: true, askedAgain: false };
    }

    // A bare number answering a wording question means an amount, not a
    // product. Handling it here keeps a tap on "2" off the model round trip.
    const parsed = quantityFromAnswer(trimmed);
    if (parsed) {
        await updateItem(item.itemId, {
            quantity: parsed.quantity,
            needsQuantity: false,
            ...(parsed.unit ? { unit: parsed.unit } : {}),
        });
        await clearClarification(item.itemId);
        const unit = parsed.unit || item.unit || 'шт';
        return { summary: `✅ ${label(item)} — ${parsed.quantity} ${unit}`, dropped: false, askedAgain: false };
    }

    if (isAffirmative(trimmed)) {
        await clearClarification(item.itemId);
        return { summary: `✅ ${label(item)}`, dropped: false, askedAgain: false };
    }

    if (isNegative(trimmed)) {
        await setClarification(item.itemId, `Напиши, будь ласка, що саме там написано замість «${item.query}»`, []);
        return { summary: `✏️ ${label(item)} — уточнюємо`, dropped: false, askedAgain: true };
    }

    const refined = await refineItemWithAnswer(
        { query: item.query, quantity: item.needsQuantity ? null : item.quantity, unit: item.unit, note: item.note },
        question.question,
        trimmed
    );
    await clearClarification(item.itemId);

    if (refined.drop) {
        await updateItem(item.itemId, { dropped: true, needsQuantity: false });
        return { summary: `🚫 ${label(item)} — прибрала зі списку`, dropped: true, askedAgain: false };
    }

    await updateItem(item.itemId, {
        query: refined.query,
        note: refined.note,
        unit: refined.unit,
        ...(refined.quantity === null
            ? { needsQuantity: item.needsQuantity }
            : { quantity: refined.quantity, needsQuantity: false }),
    });

    const updated = { query: refined.query, note: refined.note };
    const amount = refined.quantity === null ? '' : ` — ${refined.quantity} ${refined.unit || 'шт'}`;
    return { summary: `✅ ${label(updated)}${amount}`, dropped: false, askedAgain: false };
}
