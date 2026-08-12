import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverageOf, isKind, resolveKind, romanize, romanMatch, queryWords } from './taxonomy';
import { dropIrrelevant, rankCandidates, NO_FAMILIARITY, type RankingContext } from './ranking';
import type { ProductCandidate } from './products';

function product(title: string, price: number, sectionSlug: string): ProductCandidate {
    return {
        productId: title,
        externalProductId: 1,
        companyId: 'c-1',
        slug: 'slug',
        title,
        brand: '',
        imageUrl: 'https://cdn/img.png',
        price,
        oldPrice: 0,
        packaging: '1 кг',
        saleUnit: 'шт',
        weighted: false,
        minQuantity: 1,
        shelfPrice: 0,
        shelfOldPrice: 0,
        shelfUnit: '',
        inStock: true,
        hasPromo: false,
        promoLabel: '',
        url: '',
        sectionSlug,
    };
}

function context(overrides: Partial<RankingContext> = {}): RankingContext {
    return { preference: 'cheap', familiarity: NO_FAMILIARITY, ...overrides };
}

/**
 * The shelf as Silpo actually answers "помідори", in its own order: real
 * tomatoes first — none of them containing the word — then the debris that
 * does contain it.
 */
function tomatoShelf(): ProductCandidate[] {
    const tomatoes = [
        product('Томат Azura Черрі сливка', 184, 'pomidory-4825'),
        product('Томати черрі Гордій', 107.07, 'pomidory-4825'),
        product('Томат на гілці рожевий', 123.71, 'pomidory-4825'),
        product('Томати коктейльні', 76.13, 'pomidory-4825'),
        product('Томат чорний', 144.69, 'pomidory-4825'),
        product('Помідор жовтий', 80.09, 'pomidory-4825'),
    ];
    const seeds = [
        product('Насіння Агроконтракт Помідор Білий Налив 241', 7.99, 'sadzhantsi-nasinnia-482'),
        product('Насіння Агроконтракт Помідор Ранній-83', 7.99, 'sadzhantsi-nasinnia-482'),
        product('Насіння Агроконтракт Помідор Ріо Гранде', 7.99, 'sadzhantsi-nasinnia-482'),
    ];
    const other = [
        product('Помідори Kamis сушені з часником та базиліком', 19.99, 'universalni-prypravy-4960'),
        product('Томати «Премія»® цілі очищені', 54.99, 'tomatna-pasta-i-piure-4954'),
        product('Сік Садочок томатний з м\'якоттю', 45.99, 'soky-5102'),
    ];
    return [...tomatoes, ...seeds, ...other];
}

test('the store\'s own shelving answers the query the words cannot', () => {
    const kind = resolveKind(tomatoShelf(), 'помідори');
    assert.ok(kind.confident, 'a shelf named after the query word is as clear as it gets');
    assert.ok(kind.sections.has('pomidory-4825'));
    assert.equal(kind.sections.has('sadzhantsi-nasinnia-482'), false);
});

test('a tomato named "Томат" survives a search for "помідори"', () => {
    const shelf = tomatoShelf();
    const kept = dropIrrelevant(shelf, 'помідори', resolveKind(shelf, 'помідори'));
    assert.ok(kept.some(item => item.title === 'Томат Azura Черрі сливка'),
        'the word filter deleted all 46 of these and kept the seed packets');
    assert.equal(kept.some(item => item.title.startsWith('Насіння')), false);
});

test('"найдешевше" for tomatoes is a tomato, not a packet of tomato seeds', () => {
    // The reported bug, exactly: seeds at 7,99 ₴ carry the guest's word and
    // nothing else, and under the cheapest-first preference they won the line.
    const shelf = tomatoShelf();
    const kind = resolveKind(shelf, 'помідори');
    const ranked = rankCandidates(dropIrrelevant(shelf, 'помідори', kind), 'помідори', context(), kind);
    assert.equal(ranked[0].sectionSlug, 'pomidory-4825');
    assert.ok(ranked.every(item => item.sectionSlug === 'pomidory-4825'),
        'seeds, seasoning and tomato juice are all a different product');
    // The dearest tomatoes still sink, so «Найдешевше» keeps meaning something.
    assert.deepEqual(ranked.slice(-2).map(item => item.title), ['Томат чорний', 'Томат Azura Черрі сливка']);
});

test('once the shelf is settled, the preference outranks the wording', () => {
    // Both are tomatoes. Being spelled the way the guest spelled it is not a
    // reason to charge them more when they asked for the cheapest.
    const shelf = tomatoShelf();
    const kind = resolveKind(shelf, 'помідори');
    const kept = dropIrrelevant(shelf, 'помідори', kind);
    const cheap = rankCandidates(kept, 'помідори', context(), kind);
    const premium = rankCandidates(kept, 'помідори', context({ preference: 'premium' }), kind);
    assert.equal(premium[0].title, 'Томат Azura Черрі сливка', 'the dearest tomato on the shelf');
    assert.ok(cheap[0].price < premium[0].price);
});

test('a shelf holding one word-alike is not mistaken for the answer', () => {
    // Nothing here is shelved as помідори, so the taxonomy must stay quiet and
    // let the words decide rather than crowning the seed packets.
    const kind = resolveKind([
        product('Насіння Агроконтракт Помідор Ранній-83', 7.99, 'sadzhantsi-nasinnia-482'),
        product('Сік Садочок томатний', 45.99, 'soky-5102'),
    ], 'помідори');
    assert.equal(kind.confident, false);
});

test('an unshelved result — MCP\'s — falls back to reading titles', () => {
    const kind = resolveKind([
        product('Молоко Яготинське 2,5%', 41, ''),
        product('Шоколад молочний Мілка', 45, ''),
    ], 'молоко');
    assert.equal(kind.confident, false);
    assert.equal(kind.sections.size, 0);
});

test('Silpo builds its slugs by the national romanisation, so we read them', () => {
    assert.equal(romanize('помідори'), 'pomidory');
    assert.equal(romanize('хліб'), 'khlib');
    assert.equal(romanize('молоко'), 'moloko');
    assert.equal(romanize('яйця'), 'iaitsia');
});

test('butter is not shelved under hair masks', () => {
    // "масло" and "маски" both romanise to five letters stemming to "mas".
    assert.equal(romanMatch(romanize('масло'), 'masky'), false);
    assert.equal(romanMatch(romanize('масло'), 'maslo'), true);
});

test('the head noun outweighs the qualifiers around it', () => {
    // "Масло солодковершкове «Селянське»" is butter; a French butter at triple
    // the price is not a better answer for spelling the adjective in full.
    const words = queryWords('масло вершкове');
    assert.ok(coverageOf('Масло «Селянське» 73%', words) > 0.5, 'the noun alone still qualifies');
    assert.ok(coverageOf('Крем-мило вершкове', words) < 0.5, 'the adjective alone does not');
    assert.equal(coverageOf('Масло вершкове Valio 82%', words), 1);
});

/**
 * "філе куряче" as Silpo answers it: the raw chicken shelf, which also holds
 * every other cut, plus two shelves of things made from chicken fillet.
 */
function chickenShelf(): ProductCandidate[] {
    return [
        product('Куряче філе по-міланськи', 339.15, 'm-iasni-stravy-4767'),
        product('Куряче філе в лимонній паніровці', 359, 'm-iasni-stravy-4767'),
        product('Куряче філе фаршироване овочами', 359, 'm-iasni-stravy-4767'),
        product('Філе ЛТ Димні Традиції Jerky куряче в\'ялене', 79.99, 'kopchenosti-4752'),
        product('Філе М’ясна Гільдія Куряче в/к', 384, 'kopchenosti-4752'),
        product('Філе куряче «Епікур» охолоджене, малий лоток', 245.69, 'kuriatyna-4426'),
        product('Куряче філе зі стегна', 222.90, 'kuriatyna-4426'),
        product('Куряче філе', 235.29, 'kuriatyna-4426'),
        product('Куряче філе домашнє', 274, 'kuriatyna-4426'),
        product('Куряче крило кисть охолоджене', 39.99, 'kuriatyna-4426'),
        product('Куряча гомілка', 110.99, 'kuriatyna-4426'),
        product('Куряче стегно', 119, 'kuriatyna-4426'),
    ];
}

test('a qualifier may name the shelf when the head noun names nothing', () => {
    // Nothing in the shop is called "філе", but `kuriatyna` is exactly what
    // "куряче" asks for — so the second word is allowed to find the shelf.
    const kind = resolveKind(chickenShelf(), 'філе куряче');
    assert.ok(kind.confident);
    assert.equal([...kind.sections.keys()][0], 'kuriatyna-4426');
});

test('shelves that merely make something from it are trusted less', () => {
    const kind = resolveKind(chickenShelf(), 'філе куряче');
    const raw = kind.sections.get('kuriatyna-4426') ?? 0;
    assert.equal(raw, 1);
    for (const [slug, trust] of kind.sections) {
        if (slug !== 'kuriatyna-4426') assert.ok(trust < raw, `${slug} is not the chicken shelf`);
    }
});

test('a narrower line still cuts within its own shelf', () => {
    // The chicken shelf holds wings and drumsticks too, and the guest wrote
    // "філе". One word cannot cut a shelf; a qualifier can.
    const shelf = chickenShelf();
    const kept = dropIrrelevant(shelf, 'філе куряче', resolveKind(shelf, 'філе куряче'));
    assert.ok(kept.every(item => item.title.toLowerCase().includes('філе')));
    assert.equal(kept.some(item => item.title === 'Куряче крило кисть охолоджене'), false);
});

test('cheap chicken jerky does not lead the line for chicken fillet', () => {
    const shelf = chickenShelf();
    const kind = resolveKind(shelf, 'філе куряче');
    const ranked = rankCandidates(dropIrrelevant(shelf, 'філе куряче', kind), 'філе куряче', context(), kind);
    assert.equal(ranked[0].sectionSlug, 'kuriatyna-4426',
        'the cheapest thing here is 79,99 ₴ of dried snack, and it is not what was asked for');
});

test('a product with no shelving is never claimed by a shelf', () => {
    const kind = resolveKind(tomatoShelf(), 'помідори');
    assert.equal(isKind(product('Томат безрідний', 10, ''), kind), false);
});
