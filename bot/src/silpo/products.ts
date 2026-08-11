import { callMCPTool, parseMcpContent } from './mcp';
import type { StoreContext } from './store';
import { dropIrrelevant, rankCandidates, type RankingContext } from './ranking';

export interface ProductCandidate {
    productId: string;
    externalProductId: number | null;
    companyId: string;
    slug: string;
    title: string;
    brand: string;
    imageUrl: string;
    /** Price the guest actually pays for one unit, promo included. */
    price: number;
    /** Crossed-out reference price, or 0 when there is no discount. */
    oldPrice: number;
    /** Packaging as Silpo shows it: "900 г", "2 × 0,5 л", "1 кг". */
    packaging: string;
    /** Unit the price refers to for weighted goods: "кг", "100 г". */
    priceUnit: string;
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

function normalizedUnit(value: unknown): string {
    const normalized = textOf(value).toLowerCase().replace(/[.\s_-]+/g, '');
    if (/^(kg|kilogram|кілограм|кг)$/.test(normalized)) return 'кг';
    if (/^(g|gr|gram|грам|г)$/.test(normalized)) return 'г';
    if (/^(l|liter|litre|літр|л)$/.test(normalized)) return 'л';
    if (/^(ml|milliliter|мілілітр|мл)$/.test(normalized)) return 'мл';
    if (/^(pcs|pc|piece|шт|штука|од)$/.test(normalized)) return 'шт';
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

function packagingOf(product: any): string {
    const fromTitle = measurementFromText(product?.title ?? product?.name);
    if (fromTitle) return fromTitle;
    const fromDisplayRatio = measurementFromText(product?.displayRatio ?? product?.display_ratio);
    if (fromDisplayRatio) return fromDisplayRatio;
    for (const key of ['packageSize', 'weightText', 'volumeText', 'netWeightText', 'displayWeight']) {
        const measurement = measurementFromText(product?.[key]);
        if (measurement) return measurement;
    }
    const ratio = normalizedUnit(product?.ratio ?? product?.priceRatio);
    return ratio ? `1 ${ratio}` : '';
}

/** Silpo encodes multi-buy deals in `specialPrices`; only single-unit offers change the shelf price. */
function bestSpecialPrice(product: any, basePrice: number): { price: number; label: string } {
    const offers = Array.isArray(product?.specialPrices) ? product.specialPrices : [];
    let immediate = 0;
    let label = '';
    for (const offer of offers) {
        const price = numberOf(offer?.price);
        const count = numberOf(offer?.count) || 1;
        if (!price || price >= basePrice) continue;
        if (count <= 1 || String(offer?.type || '') === 'from') {
            if (!immediate || price < immediate) immediate = price;
        } else if (!label) {
            label = `${count} шт по ${formatPrice(price)}`;
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

export function normalizeProduct(raw: any): ProductCandidate | null {
    const productId = firstText(raw, ['id', 'productId', 'product_id']);
    const slug = firstText(raw, ['slug', 'productSlug', 'product_slug']);
    const title = firstText(raw, ['title', 'name', 'productName']);
    if (!productId || !title) return null;

    const basePrice = numberOf(raw?.price ?? raw?.currentPrice ?? raw?.salePrice);
    const special = bestSpecialPrice(raw, basePrice);
    const price = special.price || basePrice;
    // Nothing priceless is buyable, and under "найдешевше" a zero would outrank
    // every real product. Whatever this object is, it is not an offer.
    if (price <= 0) return null;
    const listedOld = numberOf(raw?.oldPrice ?? raw?.old_price ?? raw?.originalPrice);
    const oldPrice = listedOld > price ? listedOld : (special.price ? basePrice : 0);
    const externalId = Number(raw?.externalProductId ?? raw?.external_product_id);

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
        packaging: packagingOf(raw),
        priceUnit: normalizedUnit(raw?.ratio ?? raw?.priceRatio),
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
}

/**
 * Looks up every line of the guest's list in one MCP round trip per batch of
 * 30. Availability and price are resolved for the cart's own branch and
 * delivery type, which is what the guest will actually be charged.
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

    const timeslotStart = now.toISOString();
    const timeslotEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const results = new Map<string, ProductCandidate[]>();

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
            results.set(query, ranked);
            // How wide the choice really is, per line. `raw` against the limit
            // we asked for is the one number that says whether Silpo honours
            // `limit` per query or spreads it across the whole batch — which
            // decides whether a bigger ask would buy the guest anything.
            console.log(
                `[Search] "${query}" asked=${limitPerQuery} raw=${raw.length} priced=${normalized.length} `
                + `relevant=${relevant.length} shown=${ranked.length}`
                + (ranked.length ? ` cheapest=${formatPrice(Math.min(...ranked.map(p => p.price)))}` : '')
            );
        }
    }

    return queries.map(query => ({
        query,
        candidates: results.get(query.trim()) || [],
    }));
}
