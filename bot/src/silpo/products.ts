import { callMCPTool, parseMcpContent } from './mcp';
import { mapWithConcurrency, searchCatalogAll } from './catalog';
import { formatAmount, normalizedUnit, startingPrice } from './quantity';
import type { StoreContext } from './store';
import { dropIrrelevant, rankCandidates, type RankingContext } from './ranking';

/** Silpo is someone else's server; a shopping list is no reason to flood it. */
const CATALOG_CONCURRENCY = 6;

export interface ProductCandidate {
    productId: string;
    externalProductId: number | null;
    companyId: string;
    slug: string;
    title: string;
    brand: string;
    imageUrl: string;
    /**
     * Price of one `saleUnit`, promo included — per piece, or per kilogram for
     * weighted goods. Every sum, total and comparison uses this one.
     */
    price: number;
    /** Crossed-out reference price on the same scale, or 0 when there is no discount. */
    oldPrice: number;
    /** Packaging as Silpo shows it: "900 г", "2 × 0,5 л". Empty for weighted goods. */
    packaging: string;
    /** What one unit of quantity is: "шт", or "кг" when sold by weight. */
    saleUnit: string;
    /** True when Silpo sells this by weight, so quantity is a weight and not a count. */
    weighted: boolean;
    /**
     * The least of it the guest can buy, and the step above that — bread priced
     * per 100 г that only leaves the shelf in 0,8 кг loaves has 0.8 here.
     */
    minQuantity: number;
    /** Price as Silpo prints it on the shelf when that is not the sale-unit price; 0 when they agree. */
    shelfPrice: number;
    shelfOldPrice: number;
    /** The amount `shelfPrice` refers to: "100 г". */
    shelfUnit: string;
    inStock: boolean;
    hasPromo: boolean;
    /** Multi-buy offers such as "3 за ціною 2". */
    promoLabel: string;
    url: string;
}

const MAX_BATCH_QUERIES = 30;

/**
 * How many products each list line offers. Six looked tidy and was useless:
 * with a dozen brands of milk on the shelf, six cards mean the thing the guest
 * actually buys is usually not among them. The strip scrolls, so a long tail
 * costs nothing but bytes — and the ranking keeps the best first either way.
 */
export const CANDIDATES_PER_LINE = 20;

/** A hand-typed search is a hunt for something specific; give it the wide net. */
export const CANDIDATES_PER_SEARCH = 40;

function numberOf(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function textOf(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return String(value);
    return '';
}

function firstText(source: any, keys: string[]): string {
    for (const key of keys) {
        const value = textOf(source?.[key]);
        if (value) return value;
    }
    return '';
}

function imageOf(product: any): string {
    const direct = firstText(product, ['image', 'imageUrl', 'image_url', 'mainImage', 'main_image', 'photo', 'picture']);
    if (direct) return direct;
    const images = product?.images || product?.gallery || product?.photos;
    if (Array.isArray(images) && images.length) {
        const first = images[0];
        return textOf(first) || firstText(first, ['url', 'src', 'image', 'imageUrl', 'large', 'medium', 'small']);
    }
    return '';
}

/** Pulls "900 г" or "2 × 0,5 л" out of a product title or a metadata field. */
function measurementFromText(value: unknown): string {
    const text = textOf(value);
    if (!text) return '';
    const pack = text.match(/(\d+)\s*[xх×*]\s*(\d+(?:[.,]\d+)?)\s*(кг|kg|г|g|л|l|мл|ml)(?=$|[\s+),;/])/i);
    if (pack) {
        const unit = normalizedUnit(pack[3]);
        if (unit) return `${pack[1]} × ${pack[2].replace('.', ',')} ${unit}`;
    }
    const single = text.match(/(?:^|\s)(\d+(?:[.,]\d+)?)\s*(кг|kg|г|g|л|l|мл|ml|шт)(?=$|[\s+),;/])/i);
    if (single) {
        const unit = normalizedUnit(single[2]);
        if (unit) return `${single[1].replace('.', ',')} ${unit}`;
    }
    return '';
}

/**
 * Weighted goods have no packaging, and saying they do is a lie the guest pays
 * for: Silpo's `displayRatio` on a loaf sold by weight reads "100г", which as a
 * pack size announces a 100-gram loaf. What it really describes is the shelf
 * label's denominator, and that travels as `shelfUnit` instead.
 */
function packagingOf(product: any, weighted: boolean): string {
    const fromTitle = measurementFromText(product?.title ?? product?.name);
    if (fromTitle) return fromTitle;
    if (weighted) return '';
    const fromDisplayRatio = measurementFromText(product?.displayRatio ?? product?.display_ratio);
    if (fromDisplayRatio) return fromDisplayRatio;
    for (const key of ['packageSize', 'weightText', 'volumeText', 'netWeightText', 'displayWeight']) {
        const measurement = measurementFromText(product?.[key]);
        if (measurement) return measurement;
    }
    const ratio = normalizedUnit(product?.ratio ?? product?.priceRatio);
    return ratio ? `1 ${ratio}` : '';
}

interface OfferTerms {
    /** The least of this product that can be bought, in `saleUnit`. */
    minQuantity: number;
    saleUnit: string;
    /** How many sale units the shelf label's price covers — 10 for ₴/100 г against ₴/кг. */
    labelScale: number;
    /** The label's own denominator, so a conditional price is quoted the way the shelf quotes it. */
    shelfUnit: string;
}

/**
 * What `specialPrices` actually promises, which is less than it looks.
 *
 * Every one of these carries a `count`, and `type: "from"` means *from* that
 * much — buy two of the salami and each is 209 ₴, buy one and it is 274 ₴.
 * Treating "from" as an immediate discount, as this did, quoted the bulk price
 * to a guest buying a single pack, and across the branch not one packaged
 * product had an offer that started at a single unit. So a threshold only
 * changes the price when the smallest purchase already meets it; otherwise it is
 * something to *say*, not something to charge.
 *
 * On weighted goods the offer is quoted on the shelf label's scale — 46,90 ₴ per
 * 100 г against a product priced 529 ₴ per кг — so it is scaled onto the sale
 * unit before it is compared to anything. Without that it reads as 46,90 ₴ a
 * kilogram and sausage becomes the cheapest thing in the shop.
 */
function bestSpecialPrice(product: any, basePrice: number, terms: OfferTerms): { price: number; label: string } {
    const offers = Array.isArray(product?.specialPrices) ? product.specialPrices : [];
    let immediate = 0;
    let label = '';
    for (const offer of offers) {
        const quoted = numberOf(offer?.price);
        const offered = quoted * terms.labelScale;
        const from = numberOf(offer?.count) || terms.minQuantity;
        if (!offered || offered >= basePrice) continue;
        if (from <= terms.minQuantity) {
            if (!immediate || offered < immediate) immediate = offered;
        } else if (!label) {
            const price = terms.shelfUnit ? `${formatPrice(quoted)}/${terms.shelfUnit}` : formatPrice(offered);
            label = `від ${formatAmount(from, terms.saleUnit)} — ${price}`;
        }
    }
    return { price: immediate, label };
}

export function formatPrice(value: number): string {
    return `${value.toFixed(2).replace('.', ',')} ₴`;
}

function isAvailable(product: any): boolean {
    for (const key of ['inStock', 'in_stock', 'isAvailable', 'available']) {
        if (typeof product?.[key] === 'boolean') return product[key];
    }
    const quantity = Number(product?.availableQuantity ?? product?.stock ?? product?.quantity);
    if (Number.isFinite(quantity)) return quantity > 0;
    const status = firstText(product, ['availabilityStatus', 'stockStatus', 'productStatus']).toLowerCase();
    if (status) return !/out|немає|відсут|expected|очіку/.test(status);
    // Silpo's search endpoint only returns products sellable in the requested
    // slot, so an absent flag means "available" rather than "unknown".
    return true;
}

/**
 * Whether quantity for this product is a weight rather than a count.
 *
 * Only an explicit flag counts. A "кг" unit alone is not enough — the MCP
 * fallback describes bananas priced per kilogram without ever saying they are
 * cut to order, and guessing "weighted" there would turn a count the guest
 * typed into kilograms behind their back.
 */
function isWeighted(raw: any): boolean {
    for (const key of ['weighted', 'isWeighted', 'byWeight', 'is_weighted']) {
        if (typeof raw?.[key] === 'boolean') return raw[key];
    }
    return false;
}

export function normalizeProduct(raw: any): ProductCandidate | null {
    const productId = firstText(raw, ['id', 'productId', 'product_id']);
    const slug = firstText(raw, ['slug', 'productSlug', 'product_slug']);
    const title = firstText(raw, ['title', 'name', 'productName']);
    if (!productId || !title) return null;

    const basePrice = numberOf(raw?.price ?? raw?.currentPrice ?? raw?.salePrice);
    const weighted = isWeighted(raw);
    const saleUnit = normalizedUnit(raw?.ratio ?? raw?.priceRatio) || (weighted ? 'кг' : 'шт');
    // Silpo's own step is the minimum: the first tap of "+" on silpo.ua puts
    // exactly this much in the basket, and nothing smaller can be ordered.
    const step = numberOf(raw?.addToBasketStep ?? raw?.add_to_basket_step ?? raw?.minQuantity);
    const minQuantity = step || (weighted ? 0.1 : 1);

    // How the shelf label relates to the sale unit. A label equal to the price
    // is no second price at all, which is the case for everything packaged.
    const labelPrice = numberOf(raw?.shelfPrice);
    const labelScale = labelPrice && labelPrice !== basePrice && basePrice > 0 ? basePrice / labelPrice : 0;
    // "100г" as Silpo writes it, spaced the way Ukrainian reads it.
    const shelfUnit = labelScale ? (measurementFromText(raw?.shelfUnit) || textOf(raw?.shelfUnit)) : '';

    const special = bestSpecialPrice(raw, basePrice, {
        minQuantity,
        saleUnit,
        labelScale: labelScale || 1,
        shelfUnit,
    });
    const price = special.price || basePrice;
    // Nothing priceless is buyable, and under "найдешевше" a zero would outrank
    // every real product. Whatever this object is, it is not an offer.
    if (price <= 0) return null;
    const listedOld = numberOf(raw?.oldPrice ?? raw?.old_price ?? raw?.originalPrice);
    const oldPrice = listedOld > price ? listedOld : (special.price ? basePrice : 0);
    const externalId = Number(raw?.externalProductId ?? raw?.external_product_id);
    // Derived rather than read, so a promo shows up in the label too instead of
    // the card claiming one price and its unit line another.
    const onLabel = (value: number): number =>
        labelScale ? Math.round((value / labelScale) * 100) / 100 : 0;

    return {
        productId,
        externalProductId: Number.isSafeInteger(externalId) && externalId > 0 ? externalId : null,
        companyId: firstText(raw, ['companyId', 'company_id']),
        slug,
        title,
        brand: firstText(raw, ['brand', 'brandName', 'trademark']),
        imageUrl: imageOf(raw),
        price,
        oldPrice,
        packaging: packagingOf(raw, weighted),
        saleUnit,
        weighted,
        minQuantity,
        shelfPrice: onLabel(price),
        shelfOldPrice: onLabel(oldPrice),
        shelfUnit,
        inStock: isAvailable(raw),
        hasPromo: Boolean(special.price) || oldPrice > price || Boolean(raw?.hasPromo ?? raw?.isPromo),
        promoLabel: special.label,
        url: slug ? `https://silpo.ua/product/${slug}` : '',
    };
}

/**
 * What counts as a product rather than something a product mentions.
 *
 * "An id and a name" is not enough, and assuming it was is what filled the
 * picker with rubbish: every product carries a nested `category` and
 * `trademark`, each with an id and a name, so two beers arrived as six cards —
 * two real ones, "Пиво" and "Оболонь" twice over. Worse, those cards have no
 * price, and a price of zero beats every real product under "найдешевше".
 *
 * A price is what separates the two. Nothing sellable lacks one, and nothing
 * without one belongs in front of a guest.
 */
function looksLikeProduct(value: any): boolean {
    const hasIdentity = [value.id, value.productId, value.product_id, value.slug]
        .some(candidate => candidate !== undefined && candidate !== null && candidate !== '');
    if (!hasIdentity) return false;
    if (!textOf(value.title ?? value.name ?? value.productName)) return false;
    return numberOf(value.price ?? value.currentPrice ?? value.salePrice) > 0;
}

/** Collects every product under a node, keeping document order. */
export function collectProducts(value: any, out: any[] = [], visited = new Set<any>()): any[] {
    if (!value || typeof value !== 'object' || visited.has(value)) return out;
    visited.add(value);
    if (Array.isArray(value)) {
        value.forEach(item => collectProducts(item, out, visited));
        return out;
    }
    // Once something is a product, its own fields are its attributes — a price
    // tier, a category, a brand — and never more products. Descending into it
    // is what turned every product into three.
    if (looksLikeProduct(value)) {
        out.push(value);
        return out;
    }
    Object.values(value).forEach(nested => collectProducts(nested, out, visited));
    return out;
}

function normalizeQueryKey(value: string): string {
    return value.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim();
}

/**
 * Splits a batch response back into per-query buckets. Silpo groups results
 * under a `queries` array; if that shape ever changes, every product falls
 * into one bucket rather than being lost.
 */
export function groupByQuery(response: any, queries: string[]): Map<string, any[]> {
    const grouped = new Map<string, any[]>();
    const roots = parseMcpContent(response);

    const queryGroups: any[] = [];
    const visit = (value: any, visited = new Set<any>()): void => {
        if (!value || typeof value !== 'object' || visited.has(value)) return;
        visited.add(value);
        if (Array.isArray(value)) return value.forEach(item => visit(item, visited));
        if (Array.isArray(value.queries)) queryGroups.push(...value.queries);
        Object.values(value).forEach(nested => visit(nested, visited));
    };
    roots.forEach(root => visit(root));

    for (const group of queryGroups) {
        const label = firstText(group, ['query', 'search', 'term', 'name', 'text']);
        const products = collectProducts(group);
        if (!products.length) continue;
        const key = normalizeQueryKey(label);
        const match = queries.find(query => normalizeQueryKey(query) === key);
        grouped.set(match ?? label ?? key, products);
    }

    if (grouped.size === 0) {
        const flat = roots.flatMap(root => collectProducts(root));
        if (flat.length && queries.length === 1) grouped.set(queries[0], flat);
    }
    return grouped;
}

function dedupe(products: ProductCandidate[]): ProductCandidate[] {
    const seen = new Set<string>();
    return products.filter(product => {
        if (seen.has(product.productId)) return false;
        seen.add(product.productId);
        return true;
    });
}

export interface QueryResult {
    query: string;
    candidates: ProductCandidate[];
    /** How many products the store has for this query — the strip shows a slice. */
    total: number;
}

/**
 * Runs one line against the full store catalogue and keeps the best of it.
 *
 * The pool is the whole shelf, not a prefix of it: ranking cannot pick the
 * cheapest product on a shelf it never saw, and the strip and «Усі варіанти»
 * have to be slices of the same shelf or they contradict each other.
 */
async function resolveFromCatalog(
    context: Pick<StoreContext, 'branchId' | 'deliveryType'>,
    query: string,
    ranking: RankingContext,
    limitPerQuery: number
): Promise<QueryResult> {
    const page = await searchCatalogAll(context, query);
    const normalized = dedupe(page.items);
    const relevant = dropIrrelevant(normalized, query);
    const ranked = rankCandidates(relevant, query, ranking).slice(0, limitPerQuery);
    console.log(
        `[Search] "${query}" store=${page.total} fetched=${normalized.length} `
        + `relevant=${relevant.length} shown=${ranked.length}`
        + (relevant.length ? ` cheapest=${formatPrice(Math.min(...relevant.map(startingPrice)))}` : '')
    );
    return { query, candidates: ranked, total: relevant.length };
}

export const SHELF_SORTS = ['best', 'cheap', 'promo'] as const;
export type ShelfSort = (typeof SHELF_SORTS)[number];

const SHELF_TTL_MS = 2 * 60 * 1000;
const shelfCache = new Map<string, { expiresAt: number; items: ProductCandidate[] }>();

function discountOf(product: ProductCandidate): number {
    return product.oldPrice > product.price ? 1 - product.price / product.oldPrice : 0;
}

/**
 * Every product the store has for one line, ordered as the guest asked.
 *
 * Cached for a couple of minutes because paging through it must not re-fetch
 * three pages from Silpo per tap — and because the answer to "показати ще" has
 * to be the continuation of the same list, not a fresh roll of the dice.
 */
export async function loadShelf(
    context: Pick<StoreContext, 'branchId' | 'deliveryType'>,
    query: string,
    ranking: RankingContext,
    sort: ShelfSort
): Promise<ProductCandidate[]> {
    const key = `${context.branchId}|${context.deliveryType}|${query.toLocaleLowerCase('uk-UA')}`;
    const cached = shelfCache.get(key);
    let items = cached && cached.expiresAt > Date.now() ? cached.items : null;

    if (!items) {
        const page = await searchCatalogAll(context, query);
        items = dropIrrelevant(dedupe(page.items), query);
        shelfCache.set(key, { expiresAt: Date.now() + SHELF_TTL_MS, items });
        console.log(`[Shelf] "${query}" store=${page.total} relevant=${items.length}`);
    }

    // Out of stock always sinks, whatever the ordering: it is not an offer.
    const inStockFirst = (left: ProductCandidate, right: ProductCandidate): number =>
        Number(right.inStock) - Number(left.inStock);

    // Cheapest means "costs me least", which for goods cut to order is one
    // minimum portion rather than a kilogram nobody is buying.
    if (sort === 'cheap') {
        return [...items].sort((left, right) =>
            inStockFirst(left, right) || startingPrice(left) - startingPrice(right));
    }
    if (sort === 'promo') {
        return [...items].sort((left, right) => inStockFirst(left, right)
            || discountOf(right) - discountOf(left)
            || startingPrice(left) - startingPrice(right));
    }
    return rankCandidates(items, query, ranking);
}

/**
 * Looks up every line of the guest's list against the store they shop in.
 *
 * The storefront catalogue is the source, because it is the same one the guest
 * is looking at when they tell us we missed the cheap beer. MCP's batch search
 * stays as a fallback for the day the storefront is unreachable — it still
 * finds products, just not all of them.
 */
export async function findProductsForQueries(
    token: string,
    context: Pick<StoreContext, 'branchId' | 'deliveryType'>,
    queries: string[],
    ranking: RankingContext,
    limitPerQuery = CANDIDATES_PER_LINE,
    now = new Date()
): Promise<QueryResult[]> {
    const unique = [...new Set(queries.map(query => query.trim()).filter(Boolean))];
    if (!unique.length) return [];

    const resolved = await mapWithConcurrency(unique, CATALOG_CONCURRENCY, async (query) => {
        try {
            return await resolveFromCatalog(context, query, ranking, limitPerQuery);
        } catch (error) {
            console.warn(`[Search] Catalogue failed for "${query}":`, error);
            return null;
        }
    });

    if (resolved.some(Boolean)) {
        const byQuery = new Map(resolved.filter(Boolean).map(result => [result!.query, result!]));
        return queries.map(query => byQuery.get(query.trim())
            ?? { query, candidates: [], total: 0 });
    }

    // Every line failed, so this is the catalogue being down rather than an odd
    // query. Fall back to the official search instead of an empty list.
    console.warn('[Search] Storefront catalogue unavailable — falling back to MCP');
    return findViaMcp(token, context, unique, queries, ranking, limitPerQuery, now);
}

async function findViaMcp(
    token: string,
    context: Pick<StoreContext, 'branchId' | 'deliveryType'>,
    unique: string[],
    queries: string[],
    ranking: RankingContext,
    limitPerQuery: number,
    now: Date
): Promise<QueryResult[]> {
    const timeslotStart = now.toISOString();
    const timeslotEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const results = new Map<string, { candidates: ProductCandidate[]; total: number }>();

    for (let index = 0; index < unique.length; index += MAX_BATCH_QUERIES) {
        const batch = unique.slice(index, index + MAX_BATCH_QUERIES);
        const response = await callMCPTool(token, 'silpo_find_products_batch', {
            branchId: context.branchId,
            deliveryType: context.deliveryType,
            timeslotStart,
            timeslotEnd,
            products: batch,
            limit: limitPerQuery,
        });
        const grouped = groupByQuery(response, batch);
        for (const query of batch) {
            const raw = grouped.get(query) || [];
            const normalized = dedupe(raw.map(normalizeProduct).filter(Boolean) as ProductCandidate[]);
            // Filter first, then rank: a preference must never promote a
            // product that is not what the guest asked for.
            const relevant = dropIrrelevant(normalized, query);
            const ranked = rankCandidates(relevant, query, ranking).slice(0, limitPerQuery);
            results.set(query, { candidates: ranked, total: relevant.length });
            console.log(
                `[Search:mcp] "${query}" asked=${limitPerQuery} raw=${raw.length} `
                + `relevant=${relevant.length} shown=${ranked.length}`
            );
        }
    }

    return queries.map(query => ({
        query,
        ...(results.get(query.trim()) ?? { candidates: [], total: 0 }),
    }));
}
