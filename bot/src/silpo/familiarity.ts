import { callMCPTool, parseMcpContent } from './mcp';
import { normalizeText, type Familiarity, NO_FAMILIARITY } from './ranking';
import type { StoreContext } from './store';

// What the guest already buys is the strongest signal we have for "the right
// one of these fifteen". Silpo exposes it through favorites and order history,
// so a repeat purchase can win over an arbitrary catalogue hit.

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<number, { expiresAt: number; familiarity: Familiarity }>();

function collectProducts(value: any, out: any[] = [], visited = new Set<any>()): any[] {
    if (!value || typeof value !== 'object' || visited.has(value)) return out;
    visited.add(value);
    if (Array.isArray(value)) {
        value.forEach(item => collectProducts(item, out, visited));
        return out;
    }
    const id = value.productId ?? value.product_id ?? value.id;
    const title = value.title ?? value.name ?? value.productName;
    if (id !== undefined && typeof title === 'string') out.push({ id: String(id), title });
    Object.values(value).forEach(nested => collectProducts(nested, out, visited));
    return out;
}

function harvest(response: any, familiarity: Familiarity): void {
    for (const root of parseMcpContent(response)) {
        for (const product of collectProducts(root)) {
            if (product.id) familiarity.productIds.add(product.id);
            const title = normalizeText(product.title);
            if (title.length > 2) familiarity.titles.add(title);
        }
    }
}

/**
 * Loads the guest's favorites and recent purchases. Every source is optional:
 * a guest with no history simply gets an empty set, and a failing call must
 * never block the search.
 */
export async function loadFamiliarity(
    tgId: number,
    context: Pick<StoreContext, 'branchId' | 'deliveryType'>,
    token: string
): Promise<Familiarity> {
    const cached = cache.get(tgId);
    if (cached && cached.expiresAt > Date.now()) return cached.familiarity;

    // These three tools require the store context. Calling them without it
    // failed every single time — silently, because a missing history is not an
    // error — so "⭐ те, що я вже брав" had no history to rank by at all.
    const store = { branchId: context.branchId, deliveryType: context.deliveryType };
    const results = await Promise.allSettled([
        callMCPTool(token, 'silpo_get_my_favorites', store),
        callMCPTool(token, 'silpo_get_my_online_orders', { ...store, limit: 10, offset: 0 }),
        callMCPTool(token, 'silpo_get_my_offline_orders', { ...store, limit: 10, offset: 0 }),
    ]);

    const familiarity: Familiarity = { productIds: new Set(), titles: new Set() };
    for (const result of results) {
        if (result.status === 'fulfilled') harvest(result.value, familiarity);
        else console.warn('[Familiarity] Source unavailable:', result.reason);
    }

    cache.set(tgId, { expiresAt: Date.now() + CACHE_TTL_MS, familiarity });
    return familiarity;
}

export async function loadFamiliaritySafely(
    tgId: number,
    context: Pick<StoreContext, 'branchId' | 'deliveryType'>,
    token: string
): Promise<Familiarity> {
    try {
        return await loadFamiliarity(tgId, context, token);
    } catch (error) {
        console.warn('[Familiarity] Falling back to no history:', error);
        return NO_FAMILIARITY;
    }
}
