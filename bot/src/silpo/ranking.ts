import type { ProductCandidate } from './products';
import { startingPrice } from './quantity';

// Which product should sit first under a list line. Catalogue search returns
// whatever matches the words, so "молоко" happily brings back condensed milk
// and milk chocolate. Relevance therefore dominates the score, and the guest's
// stated preference only breaks ties among things that genuinely fit.

export type SearchPreference = 'cheap' | 'promo' | 'familiar' | 'premium';

export const SEARCH_PREFERENCES: SearchPreference[] = ['cheap', 'promo', 'familiar', 'premium'];

export function isSearchPreference(value: unknown): value is SearchPreference {
    return typeof value === 'string' && (SEARCH_PREFERENCES as string[]).includes(value);
}

export interface Familiarity {
    /** Products the guest has bought or saved before. */
    productIds: Set<string>;
    /** Normalized titles, so a repurchase is recognized across product ids. */
    titles: Set<string>;
}

export const NO_FAMILIARITY: Familiarity = { productIds: new Set(), titles: new Set() };

export interface RankingContext {
    preference: SearchPreference;
    familiarity: Familiarity;
}

export function normalizeText(value: string): string {
    return value
        .toLocaleLowerCase('uk-UA')
        .replace(/[«»"'`’,.()\[\]/\\|+*%]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Crude Ukrainian stemming: trim the inflected ending so "яйця" meets "яйце"
 * and "банани" meets "банан". Short words keep their shape — cutting three
 * letters off "сир" would match anything.
 */
export function stem(word: string): string {
    if (word.length >= 5) return word.slice(0, -2);
    if (word.length === 4) return word.slice(0, -1);
    return word;
}

/**
 * Whether two words are the same word in different forms.
 *
 * The length bound is what keeps a shared root from becoming a false match:
 * "молоко" and "молочний" both stem toward "моло", which is exactly how
 * milk chocolate ends up offered for "молоко". Requiring the stems to differ
 * by at most one character separates a grammatical ending from a different
 * word built on the same root.
 */
export function stemsMatch(left: string, right: string): boolean {
    const a = stem(left);
    const b = stem(right);
    if (a === b) return true;
    if (a.startsWith(b)) return a.length - b.length <= 1;
    if (b.startsWith(a)) return b.length - a.length <= 1;
    return false;
}

function meaningfulWords(value: string): string[] {
    return normalizeText(value)
        .split(' ')
        .filter(word => word.length >= 3);
}

/** Share of the query's words present in the title, 0..1. */
export function relevanceOf(title: string, query: string): number {
    const queryWords = meaningfulWords(query);
    if (!queryWords.length) return 1;
    const titleWords = meaningfulWords(title);
    const matched = queryWords.filter(word => titleWords.some(titleWord => stemsMatch(word, titleWord)));
    return matched.length / queryWords.length;
}

/** The head word carries the product kind; missing it usually means a wrong category. */
function headWordPresent(title: string, query: string): boolean {
    const [head] = meaningfulWords(query);
    if (!head) return true;
    return relevanceOf(title, head) > 0;
}

/**
 * Whether the title says this *is* the thing, or only that it contains it.
 *
 * Silpo names a product by its kind first — "Молоко «Селянське» питне…", "Яйця
 * курячі С1…", "Пиво Stella Artois світле". Word-share relevance cannot tell
 * those from "Напій кавовий MacCoffee 3 в 1 згущене молоко" or "Майонез
 * «Європейський» на перепелиних яйцях": both mention the word, so both score a
 * perfect match. Leading with the kind is the difference.
 */
function leadsWithKind(title: string, query: string): boolean {
    const [kind] = meaningfulWords(query);
    const [lead] = meaningfulWords(title);
    return Boolean(kind && lead && stemsMatch(kind, lead));
}

function isFamiliar(product: ProductCandidate, familiarity: Familiarity): boolean {
    if (familiarity.productIds.has(product.productId)) return true;
    return familiarity.titles.has(normalizeText(product.title));
}

function discountPercent(product: ProductCandidate): number {
    if (product.oldPrice <= product.price) return 0;
    return Math.round((1 - product.price / product.oldPrice) * 100);
}

/**
 * How much the guest's stated preference is worth. It has to outweigh every
 * tiebreaker below it, or the answer stops being an answer to the question
 * that was asked.
 */
const PREFERENCE_WEIGHT = 400;

/**
 * How much "you have bought this before" is worth, per preference.
 *
 * At a flat 250 it quietly overruled price: the whole cheap-to-expensive
 * spread is worth 400, so a familiar product at the top of the range beat the
 * cheapest one on the shelf. A guest who taps «Найдешевше» is telling us that
 * habit is exactly what they want set aside — so outside «звичне» this stays a
 * tiebreaker between products the preference already rates equally.
 */
const FAMILIARITY_BONUS: Record<SearchPreference, number> = {
    familiar: 250,
    cheap: 60,
    promo: 60,
    premium: 60,
};

/**
 * How much "this is the thing itself" is worth. More than the whole price
 * spread, or a 5,99 ₴ coffee sachet wins «Найдешевше» for "молоко" and a
 * mayonnaise wins it for "яйця" — which is what a wider shelf started doing,
 * because it finally contained cheap impostors the old search never found.
 *
 * A bonus and not a filter: plenty of honest titles lead with something else —
 * "Крупа Повна Чаша гречана" for "гречка", "Вироби макаронні" for "макарони",
 * "Папір туалетний" for "туалетний папір". When nothing on the shelf leads with
 * the kind, nothing is promoted and the order is what it was.
 */
const KIND_FIRST_BONUS = 500;

export function scoreCandidate(
    product: ProductCandidate,
    query: string,
    context: RankingContext,
    priceRange: { min: number; max: number }
): number {
    let score = relevanceOf(product.title, query) * 1000;
    if (!headWordPresent(product.title, query)) score -= 600;
    if (leadsWithKind(product.title, query)) score += KIND_FIRST_BONUS;
    // Something the guest cannot buy today is never the right default.
    if (!product.inStock) score -= 2000;
    if (isFamiliar(product, context.familiarity)) score += FAMILIARITY_BONUS[context.preference];

    const span = Math.max(1, priceRange.max - priceRange.min);
    const relativePrice = (startingPrice(product) - priceRange.min) / span;

    switch (context.preference) {
        case 'cheap':
            score += (1 - relativePrice) * PREFERENCE_WEIGHT;
            break;
        case 'premium':
            score += relativePrice * PREFERENCE_WEIGHT;
            break;
        case 'promo':
            if (product.hasPromo) score += PREFERENCE_WEIGHT * 0.4;
            score += Math.min(discountPercent(product), 60) * (PREFERENCE_WEIGHT * 0.01);
            break;
        case 'familiar':
            // Familiarity already carries this preference; nudge the safest
            // looking listing so a first-time guest still gets a sane default.
            if (product.packaging) score += 30;
            break;
    }

    if (product.imageUrl) score += 30;
    if (product.packaging) score += 15;
    return score;
}

/**
 * Cheap compared against what.
 *
 * A per-kilogram price is not comparable to a per-package one: bread at 124,74
 * ₴/кг is not dearer than a 34,99 ₴ loaf, and 12,47 ₴ per 100 г is not cheaper
 * than either. What the guest can compare is the least each option can cost
 * them — one package, or one minimum portion of what is cut to order — so that
 * is the number "найдешевше" and "найкраще" both range over.
 */
export function rankCandidates(
    products: ProductCandidate[],
    query: string,
    context: RankingContext
): ProductCandidate[] {
    if (products.length <= 1) return [...products];
    const prices = products.map(startingPrice).filter(price => price > 0);
    const priceRange = {
        min: prices.length ? Math.min(...prices) : 0,
        max: prices.length ? Math.max(...prices) : 0,
    };
    return [...products]
        .map(product => ({ product, score: scoreCandidate(product, query, context, priceRange) }))
        .sort((left, right) => right.score - left.score)
        .map(entry => entry.product);
}

/** Drops results that are clearly a different product than the one asked for. */
export function dropIrrelevant(products: ProductCandidate[], query: string): ProductCandidate[] {
    const relevant = products.filter(product => relevanceOf(product.title, query) >= 0.5);
    // Never leave a line empty just because the wording was unusual.
    return relevant.length ? relevant : products;
}
