import crypto from 'crypto';
import db from '../db/index';
import type { ParsedItem } from '../ai/list-parser';
import type { ProductCandidate } from '../silpo/products';
import { isSearchPreference, type SearchPreference } from '../silpo/ranking';

export type ListStage = 'clarifying' | 'searching' | 'picking' | 'done';

export interface Clarification {
    question: string;
    options: string[];
}

export interface ListItemRecord {
    itemId: string;
    listId: string;
    position: number;
    rawText: string;
    query: string;
    quantity: number;
    unit: string;
    note: string;
    needsQuantity: boolean;
    clarification: Clarification | null;
    candidates: ProductCandidate[];
    /** How many products the store has for this line — the strip shows a slice. */
    candidatesTotal: number;
    selectedProductId: string;
    dropped: boolean;
}

export interface ListRecord {
    listId: string;
    tgId: number;
    stage: ListStage;
    source: 'photo' | 'text';
    branchId: string;
    deliveryType: string;
    storeLabel: string;
    questionIndex: number;
    chatMessageId: number | null;
    /** How the guest wants candidates ordered; null until they choose. */
    preference: SearchPreference | null;
}

function newId(): string {
    return crypto.randomBytes(9).toString('base64url');
}

function parseJson<T>(value: unknown, fallback: T): T {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function toListRecord(row: any): ListRecord {
    return {
        listId: String(row.list_id),
        tgId: Number(row.tg_id),
        stage: String(row.stage) as ListStage,
        source: row.source === 'photo' ? 'photo' : 'text',
        branchId: String(row.branch_id || ''),
        deliveryType: String(row.delivery_type || ''),
        storeLabel: String(row.store_label || ''),
        questionIndex: Number(row.question_index || 0),
        chatMessageId: row.chat_message_id === null || row.chat_message_id === undefined
            ? null
            : Number(row.chat_message_id),
        preference: isSearchPreference(row.preference) ? row.preference : null,
    };
}

function toItemRecord(row: any): ListItemRecord {
    return {
        itemId: String(row.item_id),
        listId: String(row.list_id),
        position: Number(row.position),
        rawText: String(row.raw_text || ''),
        query: String(row.query || ''),
        quantity: Number(row.quantity) || 1,
        unit: String(row.unit || ''),
        note: String(row.note || ''),
        needsQuantity: Number(row.needs_quantity) === 1,
        clarification: parseJson<Clarification | null>(row.clarification, null),
        candidates: parseJson<ProductCandidate[]>(row.candidates, []),
        candidatesTotal: Number(row.candidates_total) || 0,
        selectedProductId: String(row.selected_product_id || ''),
        dropped: Number(row.dropped) === 1,
    };
}

export async function ensureUser(tgId: number, firstName?: string): Promise<void> {
    await db.prepare('INSERT OR IGNORE INTO users (tg_id, first_name) VALUES (?, ?)').run(tgId, firstName || null);
    if (firstName) {
        await db.prepare('UPDATE users SET first_name = ? WHERE tg_id = ? AND (first_name IS NULL OR first_name = \'\')')
            .run(firstName, tgId);
    }
}

export async function createList(
    tgId: number,
    source: 'photo' | 'text',
    rawInput: string,
    items: ParsedItem[]
): Promise<ListRecord> {
    const listId = newId();
    await db.prepare(`
        INSERT INTO lists (list_id, tg_id, stage, source, raw_input)
        VALUES (?, ?, 'clarifying', ?, ?)
    `).run(listId, tgId, source, rawInput.slice(0, 4000));

    for (const [index, item] of items.entries()) {
        const clarification = item.question
            ? JSON.stringify({ question: item.question, options: item.options })
            : null;
        await db.prepare(`
            INSERT INTO list_items
                (item_id, list_id, position, raw_text, query, quantity, unit, note, needs_quantity, clarification)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            newId(),
            listId,
            index,
            item.raw,
            item.query,
            item.quantity ?? 1,
            item.unit,
            item.note,
            item.quantity === null ? 1 : 0,
            clarification
        );
    }

    return (await getList(listId))!;
}

export async function getList(listId: string): Promise<ListRecord | null> {
    const row = await db.prepare('SELECT * FROM lists WHERE list_id = ?').get(listId);
    return row ? toListRecord(row) : null;
}

/** The list the guest is currently working on, if any. */
export async function getActiveList(tgId: number): Promise<ListRecord | null> {
    const row = await db.prepare(`
        SELECT * FROM lists
        WHERE tg_id = ? AND stage != 'done'
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
    `).get(tgId);
    return row ? toListRecord(row) : null;
}

export async function getLatestList(tgId: number): Promise<ListRecord | null> {
    const row = await db.prepare(`
        SELECT * FROM lists WHERE tg_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1
    `).get(tgId);
    return row ? toListRecord(row) : null;
}

export async function getItems(listId: string): Promise<ListItemRecord[]> {
    const rows = await db.prepare(`
        SELECT * FROM list_items WHERE list_id = ? ORDER BY position ASC
    `).all(listId);
    return rows.map(toItemRecord);
}

export async function getActiveItems(listId: string): Promise<ListItemRecord[]> {
    return (await getItems(listId)).filter(item => !item.dropped);
}

export async function getItem(itemId: string): Promise<ListItemRecord | null> {
    const row = await db.prepare('SELECT * FROM list_items WHERE item_id = ?').get(itemId);
    return row ? toItemRecord(row) : null;
}

async function touchList(listId: string): Promise<void> {
    await db.prepare('UPDATE lists SET updated_at = CURRENT_TIMESTAMP WHERE list_id = ?').run(listId);
}

export async function setStage(listId: string, stage: ListStage): Promise<void> {
    await db.prepare('UPDATE lists SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE list_id = ?').run(stage, listId);
}

export async function setStoreContext(
    listId: string,
    context: { branchId: string; deliveryType: string; storeLabel: string }
): Promise<void> {
    await db.prepare(`
        UPDATE lists SET branch_id = ?, delivery_type = ?, store_label = ?, updated_at = CURRENT_TIMESTAMP
        WHERE list_id = ?
    `).run(context.branchId, context.deliveryType, context.storeLabel, listId);
}

export async function setQuestionIndex(listId: string, index: number): Promise<void> {
    await db.prepare('UPDATE lists SET question_index = ?, updated_at = CURRENT_TIMESTAMP WHERE list_id = ?')
        .run(index, listId);
}

export async function setPreference(listId: string, preference: SearchPreference): Promise<void> {
    await db.prepare('UPDATE lists SET preference = ?, updated_at = CURRENT_TIMESTAMP WHERE list_id = ?')
        .run(preference, listId);
}

export async function setChatMessageId(listId: string, messageId: number | null): Promise<void> {
    await db.prepare('UPDATE lists SET chat_message_id = ? WHERE list_id = ?').run(messageId, listId);
}

export async function updateItem(
    itemId: string,
    updates: Partial<Pick<ListItemRecord, 'query' | 'quantity' | 'unit' | 'note' | 'needsQuantity' | 'dropped' | 'selectedProductId'>>
): Promise<void> {
    const columns: Record<string, unknown> = {};
    if (updates.query !== undefined) columns.query = updates.query;
    if (updates.quantity !== undefined) columns.quantity = updates.quantity;
    if (updates.unit !== undefined) columns.unit = updates.unit;
    if (updates.note !== undefined) columns.note = updates.note;
    if (updates.needsQuantity !== undefined) columns.needs_quantity = updates.needsQuantity ? 1 : 0;
    if (updates.dropped !== undefined) columns.dropped = updates.dropped ? 1 : 0;
    if (updates.selectedProductId !== undefined) columns.selected_product_id = updates.selectedProductId;

    const entries = Object.entries(columns);
    if (!entries.length) return;
    const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
    await db.prepare(`UPDATE list_items SET ${assignments} WHERE item_id = ?`)
        .run(...entries.map(([, value]) => value), itemId);
}

export async function clearClarification(itemId: string): Promise<void> {
    await db.prepare('UPDATE list_items SET clarification = NULL WHERE item_id = ?').run(itemId);
}

export async function setCandidates(
    itemId: string,
    candidates: ProductCandidate[],
    total = candidates.length
): Promise<void> {
    await db.prepare('UPDATE list_items SET candidates = ?, candidates_total = ? WHERE item_id = ?')
        .run(JSON.stringify(candidates), total, itemId);
}

export async function selectProduct(itemId: string, productId: string): Promise<void> {
    await db.prepare('UPDATE list_items SET selected_product_id = ? WHERE item_id = ?').run(productId, itemId);
}

export async function markDone(listId: string): Promise<void> {
    await setStage(listId, 'done');
}

export async function abandonActiveLists(tgId: number): Promise<void> {
    await db.prepare(`UPDATE lists SET stage = 'done' WHERE tg_id = ? AND stage != 'done'`).run(tgId);
}

export { touchList };
