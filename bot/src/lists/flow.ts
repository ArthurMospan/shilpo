import { withSilpoToken } from '../silpo/auth';
import { getStoreContext, type StoreContext } from '../silpo/store';
import { getStorePreference } from '../silpo/store-preference';
import { findProductsForQueries } from '../silpo/products';
import { loadFamiliaritySafely } from '../silpo/familiarity';
import type { SearchPreference } from '../silpo/ranking';
import { buildSelection, type Selection, type SelectionLine } from './selection';
import {
    getActiveItems,
    getItems,
    setCandidates,
    setStage,
    setStoreContext,
    selectProduct,
    type Clarification,
    type ListItemRecord,
} from './repository';

export interface PendingQuestion {
    item: ListItemRecord;
    question: string;
    options: string[];
}

/**
 * The one open question for a line, if any.
 *
 * A missing amount is deliberately *not* a question. The Mini App puts a
 * stepper under every line, so asking "скільки молока?" in chat buys nothing
 * and costs the guest a tap before they have even seen the products. Only
 * things that change *which* product we search for are worth interrupting for.
 */
export function questionForItem(item: ListItemRecord): PendingQuestion | null {
    if (item.dropped) return null;
    const clarification: Clarification | null = item.clarification;
    if (!clarification?.question) return null;
    // An empty option list is meaningful: it marks a question that only a
    // free-form reply can answer, such as "what does this word say?".
    return { item, question: clarification.question, options: clarification.options };
}

export async function pendingQuestions(listId: string): Promise<PendingQuestion[]> {
    const items = await getActiveItems(listId);
    return items.map(questionForItem).filter(Boolean) as PendingQuestion[];
}

export async function nextQuestion(listId: string): Promise<PendingQuestion | null> {
    return (await pendingQuestions(listId))[0] || null;
}

export interface SearchOutcome {
    context: StoreContext;
    found: ListItemRecord[];
    missing: ListItemRecord[];
}

/**
 * Resolves every list line against the Silpo catalogue for the guest's own
 * store, stores the candidates and preselects the best match so the Mini App
 * opens on a ready-to-confirm basket rather than an empty form.
 */
export async function runSearch(
    tgId: number,
    listId: string,
    preference: SearchPreference = 'familiar'
): Promise<SearchOutcome> {
    await setStage(listId, 'searching');

    return withSilpoToken(tgId, async (token) => {
        const context = await getStoreContext(token, await getStorePreference(tgId));
        await setStoreContext(listId, {
            branchId: context.branchId,
            deliveryType: context.deliveryType,
            storeLabel: context.storeLabel,
        });

        const items = await getActiveItems(listId);
        const queries = items.map(item => [item.query, item.note].filter(Boolean).join(' ').trim());
        const familiarity = await loadFamiliaritySafely(tgId, context, token);
        const results = await findProductsForQueries(token, context, queries, { preference, familiarity });

        const found: ListItemRecord[] = [];
        const missing: ListItemRecord[] = [];
        for (const [index, item] of items.entries()) {
            const candidates = results[index]?.candidates ?? [];
            await setCandidates(item.itemId, candidates, results[index]?.total ?? candidates.length);
            if (candidates.length) {
                await selectProduct(item.itemId, candidates[0].productId);
                found.push({ ...item, candidates, selectedProductId: candidates[0].productId });
            } else {
                missing.push(item);
            }
        }

        await setStage(listId, 'picking');
        return { context, found, missing };
    });
}

export async function getSelection(listId: string): Promise<Selection> {
    return buildSelection(await getItems(listId));
}

export { buildSelection };
export type { Selection, SelectionLine };
