import type { ProductCandidate } from './products';
import { startingPrice } from './quantity';
import {
    coverageOf,
    isKind,
    trustOf,
    leadsWithKind,
    normalizeText,
    queryWords,
    stem,
    stemsMatch,
    type Kind,
    NO_KIND,
} from './taxonomy';

// Which product should sit first under a list line. Catalogue search returns
// whatever matches the words, so "молоко" happily brings back condensed milk
// and milk chocolate. Relevance therefore dominates the score, and the guest's
// stated preference only breaks ties among things that genuinely fit.
//
// What "relevant" means comes from `taxonomy`: Silpo's own shelving decides the
// kind, and the words in a title only refine the order within it.

export { normalizeText, stem, stemsMatch };
export type { Kind };

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

/**
 * How much of the query the title carries, 0..1 — the head noun above the rest.
 * See `coverageOf`; this is the query-string form of it.
 */
export function relevanceOf(title: string, query: string): number {
    return coverageOf(title, queryWords(query));
}

/** The head word carries the product kind; missing it usually means a wrong category. */
function headWordPresent(title: string, query: string): boolean {
    const [head] = queryWords(query);
    if (!head) return true;
    return coverageOf(title, [head]) > 0;
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
function titleLeadsWithKind(title: string, query: string): boolean {
    return leadsWithKind(title, queryWords(query));
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

/**
 * How much standing on the right shelf is worth.
 *
 * More than a perfect title, because a perfect title is the weaker evidence of
 * the two. "Насіння Агроконтракт Помідор Ранній-83" carries the guest's word
 * exactly and is a packet of seeds; "Томат Azura Черрі сливка" carries none of
 * it and is the tomato they came for. Once Silpo's shelving has spoken clearly
 * the shelf decides, and the words only order what is already on it.
 */
const RIGHT_SHELF_BONUS = 1200;

/**
 * What the wording of a title is still worth once the shelf has been settled.
 *
 * Very little, deliberately. Every product left is the right kind by then, so
 * the words can only say which of several right answers is phrased most like
 * the question — a tiebreaker, not a verdict. Left at full weight it silently
 * repealed the guest's own instruction: «Найдешевше» over the tomato shelf
 * would hand back the tomato *named* "Помідор" over the cheaper one named
 * "Томат", which is the preference losing to a spelling.
 */
const WORD_WEIGHT_UNDER_SHELF = 150;
const WORD_WEIGHT_ALONE = 1000;

export function scoreCandidate(
    product: ProductCandidate,
    query: string,
    context: RankingContext,
    priceRange: { min: number; max: number },
    kind: Kind = NO_KIND
): number {
    const trust = trustOf(product, kind);
    let score = relevanceOf(product.title, query)
        * (kind.confident ? WORD_WEIGHT_UNDER_SHELF : WORD_WEIGHT_ALONE);
    score += trust * (kind.confident ? RIGHT_SHELF_BONUS : 500);
    // Reading the title for a kind is guesswork that the shelving does better;
    // where the shelving spoke, it is only noise on top of a settled answer.
    if (!kind.confident) {
        if (!headWordPresent(product.title, query)) score -= 600;
        if (titleLeadsWithKind(product.title, query)) score += KIND_FIRST_BONUS;
    }
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
    context: RankingContext,
    kind: Kind = NO_KIND
): ProductCandidate[] {
    if (products.length <= 1) return [...products];
    const prices = products.map(startingPrice).filter(price => price > 0);
    const priceRange = {
        min: prices.length ? Math.min(...prices) : 0,
        max: prices.length ? Math.max(...prices) : 0,
    };
    return [...products]
        .map(product => ({ product, score: scoreCandidate(product, query, context, priceRange, kind) }))
        .sort((left, right) => right.score - left.score)
        .map(entry => entry.product);
}

/** A title carrying the head noun but none of the qualifiers still counts. */
const MIN_RELEVANCE = 0.5;

/**
 * The words still have a job once the shelf is found, but only when the guest
 * asked for something narrower than the shelf itself.
 *
 * `kuriatyna` is the chicken shelf, and a guest who wrote "філе куряче" gets
 * wings, thighs and drumsticks from it unless the qualifier is allowed to cut.
 * A one-word line is different: "помідори" is not narrower than the помідори
 * shelf, and letting the word cut there is precisely what deleted every tomato
 * for being spelled "Томат".
 */
function narrowWithinShelf(onShelf: ProductCandidate[], query: string): ProductCandidate[] {
    if (queryWords(query).length < 2) return onShelf;
    const focused = onShelf.filter(product => relevanceOf(product.title, query) >= MIN_RELEVANCE);
    return focused.length ? focused : onShelf;
}

/**
 * Drops results that are clearly a different product than the one asked for.
 *
 * The shelf comes first, because words alone got this exactly backwards: a
 * word filter on "помідори" deleted all 46 tomatoes — every one of them titled
 * "Томат" — and kept four packets of tomato seeds and a jar of dried tomato
 * seasoning, which is precisely what the guest was then offered. Where the
 * shelving spoke clearly, being on the shelf *is* the qualification, and the
 * title need say nothing at all.
 */
export function dropIrrelevant(
    products: ProductCandidate[],
    query: string,
    kind: Kind = NO_KIND
): ProductCandidate[] {
    if (kind.confident) {
        const onShelf = products.filter(product => isKind(product, kind));
        // A shelf that answers the query is the answer; anything filed elsewhere
        // is a different product that merely shares a word.
        if (onShelf.length) return narrowWithinShelf(onShelf, query);
    }
    const relevant = products.filter(product => relevanceOf(product.title, query) >= MIN_RELEVANCE);
    // Never leave a line empty just because the wording was unusual.
    return relevant.length ? relevant : products;
}
