import type { ProductCandidate } from './products';

// Which shelf the guest meant, decided by Silpo's own shelving.
//
// Matching a query against product *titles* fails in both directions, and
// "помідори" shows both failures at once. Silpo's search answers it with 182
// products led by real tomatoes — every one of them titled "Томат", because
// that is the trade word. Not one contains the letters the guest typed. What
// does contain them is the debris: "Насіння Агроконтракт Помідор Ранній-83",
// "Помідори Kamis сушені з часником". So a title filter deleted all 46 real
// tomatoes and kept the seed packets, then «найдешевше» crowned a 7,99 ₴ sachet
// of seeds. The word was never the problem; reading titles was.
//
// Every storefront row carries `sectionSlug` — the shelf Silpo files it under.
// The tomatoes are `pomidory-4825`; the seeds are `sadzhantsi-nasinnia-482`;
// the spice is `universalni-prypravy-4960`. Silpo already knows that "Томат" and
// "помідор" name one shelf, and it knows it for every synonym in the shop. That
// knowledge is free, always current, and is not a dictionary we have to keep.
//
// So: find the shelf, then trust it. A guest asking for помідори gets the
// помідори shelf, whatever the labels on it happen to say.

export interface Kind {
    /**
     * The shelves that hold what was asked for, each with how well it answered,
     * 0..1 against the best of them.
     *
     * Graded rather than a plain set, because a query often lands on a family of
     * shelves that are not equally the answer. "філе куряче" reaches raw chicken,
     * ready-made chicken dishes and smoked deli fillet; all three are chicken
     * fillet and belong in the strip, but only one of them is what a shopping
     * list means. Treating them as equally right let a 79,99 ₴ packet of chicken
     * jerky lead the line.
     */
    sections: Map<string, number>;
    /**
     * Whether the shelving spoke clearly enough to outrank the wording of
     * titles. When it did not, ranking falls back to reading words.
     */
    confident: boolean;
}

export const NO_KIND: Kind = { sections: new Map(), confident: false };

/**
 * Ukrainian in Latin letters, by the national standard (KMU 2010) — which is
 * the scheme Silpo builds its slugs with. "помідори" romanises to "pomidory",
 * and `pomidory-4825` is the shelf. That agreement is the strongest evidence
 * available: the shelf is *named* the word the guest typed.
 */
const LETTERS: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z',
    и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
    р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
    щ: 'shch', ь: '', ю: 'iu', я: 'ia', "'": '', 'ʼ': '', '’': '',
};

export function romanize(word: string): string {
    return [...word.toLocaleLowerCase('uk-UA')].map(letter => LETTERS[letter] ?? letter).join('');
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

export function queryWords(value: string): string[] {
    return normalizeText(value).split(' ').filter(word => word.length >= 3);
}

/** "pomidory-4825" is a name and a number; only the name says anything. */
function sectionTokens(slug: string): string[] {
    return slug.replace(/-\d+$/, '').split('-').filter(token => token.length >= 3);
}

/**
 * Whether a romanised query word and a shelf's name are the same word.
 *
 * Stemming is too generous once the words are Latin: "масло" and "маски" both
 * romanise to five letters that stem to "mas", and that shelved butter under
 * hair masks. Agreement has to run the length of the shorter word instead.
 */
export function romanMatch(query: string, token: string): boolean {
    if (!query || !token) return false;
    if (Math.abs(query.length - token.length) > 2) return false;
    const need = Math.min(5, query.length, token.length);
    return need >= 3 && query.slice(0, need) === token.slice(0, need);
}

/**
 * How much of the query a title carries, 0..1, the head noun weighted above the
 * rest.
 *
 * A shopping line names a thing and then qualifies it. "масло вершкове" asks
 * for butter first and for that adjective second, so «Масло солодковершкове
 * "Селянське"» at 99,90 ₴ must not lose to a French butter at triple the price
 * merely for spelling the modifier differently. Flat word-share said those two
 * titles were equally good; they are not.
 */
export function coverageOf(title: string, words: string[]): number {
    if (!words.length) return 1;
    const titleWords = queryWords(title);
    const carries = (word: string): boolean => titleWords.some(titleWord => stemsMatch(word, titleWord));
    if (words.length === 1) return carries(words[0]) ? 1 : 0;
    const rest = words.slice(1);
    return (carries(words[0]) ? 0.65 : 0) + (rest.filter(carries).length / rest.length) * 0.35;
}

/** Silpo names a product by its kind first: "Молоко «Селянське» питне…". */
export function leadsWithKind(title: string, words: string[]): boolean {
    const [lead] = queryWords(title);
    return Boolean(lead && words.some(word => stemsMatch(word, lead)));
}

/** A title that carries the whole query, near enough. */
const FULL_COVERAGE = 0.99;

interface SectionEvidence {
    slug: string;
    count: number;
    /** Where Silpo first placed this shelf in its own relevance ordering. */
    firstRank: number;
    fullMatches: number;
    leadMatches: number;
}

/**
 * Which shelves answer this query.
 *
 * Four kinds of evidence, none sufficient alone:
 *
 *  - the shelf is *named* the query word (`pomidory` for "помідори") — decisive
 *    when present, and only the head word may claim it. "куряче" also romanises
 *    into `kuriachi-iaitsia`, and eggs are not chicken fillet;
 *  - titles on that shelf that lead with the kind — «Філе куряче «Епікур»»
 *    marks `kuriatyna` as the real chicken shelf even though nothing is named
 *    "курятина";
 *  - titles that carry the whole query at all;
 *  - size, and how early Silpo put the shelf.
 *
 * Size matters because a shelf of 46 tomatoes is more plausibly "помідори" than
 * a shelf holding one tomato-flavoured cracker; earliness matters because
 * Silpo's own relevance is a real opinion. Neither decides alone: Silpo answers
 * "молоко" with a blue cheese first, and answers "філе куряче" with 45 ready
 * meals against 38 raw fillets.
 */
export function resolveKind(products: ProductCandidate[], query: string): Kind {
    const words = queryWords(query);
    if (!words.length) return NO_KIND;
    const roman = words.map(romanize);

    const shelves = new Map<string, SectionEvidence>();
    products.forEach((product, rank) => {
        const slug = product.sectionSlug;
        if (!slug) return;
        let shelf = shelves.get(slug);
        if (!shelf) {
            shelf = { slug, count: 0, firstRank: rank, fullMatches: 0, leadMatches: 0 };
            shelves.set(slug, shelf);
        }
        shelf.count++;
        if (coverageOf(product.title, words) >= FULL_COVERAGE) {
            shelf.fullMatches++;
            if (leadsWithKind(product.title, words)) shelf.leadMatches++;
        }
    });
    // MCP results carry no shelving at all, and a query Silpo files under a
    // single shelf tells us nothing by comparison.
    if (shelves.size < 2) return NO_KIND;

    const scored = [...shelves.values()]
        .map(shelf => {
            const tokens = sectionTokens(shelf.slug);
            // The head noun naming a shelf is worth more than a qualifier doing
            // it, but a qualifier still counts: nothing in the shop is called
            // "філе", while `kuriatyna` is exactly what "куряче" is asking for.
            const namedBy = roman.findIndex(word => tokens.some(token => romanMatch(word, token)));
            const named = namedBy >= 0;
            return {
                slug: shelf.slug,
                named,
                score: (named ? (namedBy === 0 ? 1000 : 600) : 0)
                    + shelf.leadMatches * 120
                    + shelf.fullMatches * 40
                    + Math.min(shelf.count, 60) * 6
                    + Math.max(0, 40 - shelf.firstRank) * 4,
            };
        })
        .sort((left, right) => right.score - left.score);

    const best = scored[0];
    if (best.score <= 0) return NO_KIND;
    // Siblings of the winner come too: "сир" is answered by half a dozen cheese
    // shelves and picking one of them would hide the rest of the cheese. They
    // arrive ranked, though — a near-miss shelf is kept, not believed equally.
    const sections = new Map(scored
        .filter(shelf => shelf.score >= best.score * 0.6)
        .map(shelf => [shelf.slug, shelf.score / best.score] as const));
    // Overruling the titles is only safe when the shelving was emphatic — the
    // shelf carries one of the guest's own words, or it owns the answer outright.
    const confident = best.named || best.score >= scored[1].score * 2;
    return { sections, confident };
}

export function isKind(product: ProductCandidate, kind: Kind): boolean {
    return Boolean(product.sectionSlug) && kind.sections.has(product.sectionSlug);
}

/** How far this product's shelf is the answer, 0..1. */
export function trustOf(product: ProductCandidate, kind: Kind): number {
    return (product.sectionSlug && kind.sections.get(product.sectionSlug)) || 0;
}
