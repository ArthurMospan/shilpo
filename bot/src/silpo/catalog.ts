import { normalizeProduct, type ProductCandidate } from './products';
import type { StoreContext } from './store';

// Silpo's own storefront catalogue — the API behind silpo.ua itself.
//
// The MCP batch search answers with one page of its own relevance ordering and
// nothing else: no total, no offset. Asking it for twenty products for "пиво"
// returned twenty, and the cheapest of those cost 34,99 ₴ while the branch
// actually stocked 126 beers starting at 23,99 ₴. Sorting a relevance page by
// price cannot find the cheapest thing on a shelf it never looked at, so
// "найдешевше" was answering a question about twenty arbitrary products.
//
// This endpoint reports `total`, pages with `offset`, and is scoped to the
// same branch and delivery type as the cart — the same numbers the guest sees
// when they open silpo.ua and disagree with us. MCP stays the only way we
// touch anything: the cart, the account, the store are all still official.

const ECOM_BASE = 'https://sf-ecom-api.silpo.ua';
const IMAGE_BASE = 'https://images.silpo.ua/v2/products/400x400/webp';
const REQUEST_TIMEOUT_MS = 10_000;

/** Silpo caps a page at 100 however much more you ask for. */
export const MAX_PAGE = 100;

/** Beyond this a line is not a choice any more, and every page costs a hop. */
export const MAX_PRODUCTS_PER_QUERY = 300;

export class CatalogUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CatalogUnavailableError';
    }
}

async function requestJson(path: string): Promise<any> {
    const response = await fetch(`${ECOM_BASE}${path}`, {
        headers: {
            accept: 'application/json',
            'accept-language': 'uk,en;q=0.9',
            origin: 'https://silpo.ua',
            referer: 'https://silpo.ua/',
            'user-agent': 'Mozilla/5.0 (compatible; Shilpo/1.0)',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new CatalogUnavailableError(`Silpo catalogue ${response.status}: ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : null;
}

/**
 * Reshapes a storefront row into the fields `normalizeProduct` reads, so
 * packaging, promo pricing and availability keep one definition whichever
 * source a candidate came from.
 */
function fromStorefront(raw: any): ProductCandidate | null {
    if (!raw || typeof raw !== 'object') return null;
    const icon = typeof raw.icon === 'string' ? raw.icon.trim() : '';
    return normalizeProduct({
        ...raw,
        price: raw.displayPrice ?? raw.price,
        oldPrice: raw.displayOldPrice ?? raw.oldPrice,
        image: icon ? `${IMAGE_BASE}/${icon}` : '',
        brand: raw.brandTitle ?? '',
        // `stock` is the storefront's availability signal for this very branch
        // and delivery type; isAvailable() already reads it.
        stock: raw.stock,
    });
}

export interface CatalogPage {
    items: ProductCandidate[];
    /** How many products Silpo has for this query in this store, in total. */
    total: number;
}

export type CatalogSort = 'price' | 'popularity' | 'title';

function searchPath(
    context: Pick<StoreContext, 'branchId' | 'deliveryType'>,
    query: string,
    options: { limit: number; offset: number; sortBy?: CatalogSort }
): string {
    const params = new URLSearchParams({
        search: query,
        deliveryType: context.deliveryType,
        limit: String(Math.min(Math.max(1, options.limit), MAX_PAGE)),
        offset: String(Math.max(0, options.offset)),
    });
    if (options.sortBy) params.set('sortBy', options.sortBy);
    return `/v1/uk/branches/${encodeURIComponent(context.branchId)}/products?${params}`;
}

export async function searchCatalogPage(
    context: Pick<StoreContext, 'branchId' | 'deliveryType'>,
    query: string,
    options: { limit: number; offset: number; sortBy?: CatalogSort }
): Promise<CatalogPage> {
    const payload = await requestJson(searchPath(context, query, options));
    const rows = Array.isArray(payload?.items) ? payload.items : [];
    return {
        items: rows.map(fromStorefront).filter(Boolean) as ProductCandidate[],
        total: Number(payload?.total) || rows.length,
    };
}

/**
 * Everything the store has for one query, up to a sane ceiling.
 *
 * Ranking has to see the whole shelf: "найдешевше" over a partial set is a
 * guess dressed as an answer. Typical queries come back between 40 and 150
 * products, so this is one or two round trips.
 */
export async function searchCatalogAll(
    context: Pick<StoreContext, 'branchId' | 'deliveryType'>,
    query: string,
    cap = MAX_PRODUCTS_PER_QUERY
): Promise<CatalogPage> {
    const first = await searchCatalogPage(context, query, { limit: MAX_PAGE, offset: 0 });
    const wanted = Math.min(first.total, cap);
    if (first.items.length >= wanted) return { items: first.items.slice(0, cap), total: first.total };

    const offsets: number[] = [];
    for (let offset = MAX_PAGE; offset < wanted; offset += MAX_PAGE) offsets.push(offset);
    const pages = await Promise.all(offsets.map(offset =>
        searchCatalogPage(context, query, { limit: MAX_PAGE, offset })
            .catch(() => ({ items: [] as ProductCandidate[], total: first.total }))));

    const items = [...first.items, ...pages.flatMap(page => page.items)];
    const seen = new Set<string>();
    return {
        items: items.filter(item => !seen.has(item.productId) && seen.add(item.productId)).slice(0, cap),
        total: first.total,
    };
}

/**
 * Runs many line queries without opening a hundred sockets at once. Silpo is
 * someone else's server and a shopping list is not a reason to hammer it.
 */
export async function mapWithConcurrency<T, R>(
    values: T[],
    limit: number,
    worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
        while (cursor < values.length) {
            const index = cursor++;
            results[index] = await worker(values[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}
