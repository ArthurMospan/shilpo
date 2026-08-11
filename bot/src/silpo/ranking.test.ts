import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropIrrelevant, rankCandidates, relevanceOf, stemsMatch, NO_FAMILIARITY, type RankingContext } from './ranking';
import type { ProductCandidate } from './products';

function product(overrides: Partial<ProductCandidate> & { title: string; price: number }): ProductCandidate {
    return {
        productId: overrides.title,
        externalProductId: 1,
        companyId: 'c-1',
        slug: 'slug',
        brand: '',
        imageUrl: 'https://cdn/img.png',
        oldPrice: 0,
        packaging: '1 л',
        priceUnit: '',
        inStock: true,
        hasPromo: false,
        promoLabel: '',
        url: '',
        ...overrides,
    };
}

function context(overrides: Partial<RankingContext> = {}): RankingContext {
    return { preference: 'familiar', familiarity: NO_FAMILIARITY, ...overrides };
}

test('Ukrainian inflection still counts as a match', () => {
    assert.ok(relevanceOf('Яйця курячі С0, 10 шт', 'яйце') > 0);
    assert.ok(relevanceOf('Банани', 'банан') > 0);
    assert.ok(relevanceOf('Молоко Яготинське 2,5%', 'молока') > 0);
    assert.ok(relevanceOf('Рибка солона', 'риба') > 0);
});

test('a shared root is not a match — this is what offered chocolate for milk', () => {
    assert.equal(relevanceOf('Шоколад молочний Мілка', 'молоко'), 0);
    assert.equal(stemsMatch('молоко', 'молочний'), false);
    assert.equal(stemsMatch('яйце', 'яйця'), true);
});

test('an unrelated product scores no relevance', () => {
    assert.equal(relevanceOf('Шоколад молочний Мілка', 'олія соняшникова'), 0);
});

test('products from another category are dropped before ranking', () => {
    const candidates = [
        product({ title: 'Шоколад молочний Мілка 90 г', price: 45 }),
        product({ title: 'Молоко Яготинське 2,5% 900 г', price: 41 }),
    ];
    const kept = dropIrrelevant(candidates, 'молоко');
    assert.equal(kept.length, 1);
    assert.equal(kept[0].title, 'Молоко Яготинське 2,5% 900 г');
});

test('an empty result is never produced by filtering alone', () => {
    const candidates = [product({ title: 'Щось незвичне', price: 10 })];
    assert.equal(dropIrrelevant(candidates, 'зовсім інше').length, 1, 'better an odd match than an empty line');
});

test('"cheapest" puts the lowest price first', () => {
    const ranked = rankCandidates([
        product({ title: 'Молоко Преміум 2,5% 900 г', price: 62 }),
        product({ title: 'Молоко Селянське 2,5% 900 г', price: 38 }),
    ], 'молоко', context({ preference: 'cheap' }));
    assert.equal(ranked[0].price, 38);
});

test('"premium" flips that order', () => {
    const ranked = rankCandidates([
        product({ title: 'Молоко Селянське 2,5% 900 г', price: 38 }),
        product({ title: 'Молоко Преміум 2,5% 900 г', price: 62 }),
    ], 'молоко', context({ preference: 'premium' }));
    assert.equal(ranked[0].price, 62);
});

test('"on promo" prefers a real discount over a cheaper plain product', () => {
    const ranked = rankCandidates([
        product({ title: 'Молоко Селянське 2,5% 900 г', price: 38 }),
        product({ title: 'Молоко Яготинське 2,5% 900 г', price: 42, oldPrice: 60, hasPromo: true }),
    ], 'молоко', context({ preference: 'promo' }));
    assert.equal(ranked[0].hasPromo, true);
});

test('something the guest already buys wins by default', () => {
    const familiar = product({ title: 'Молоко Яготинське 2,5% 900 г', price: 55 });
    const ranked = rankCandidates([
        product({ title: 'Молоко Селянське 2,5% 900 г', price: 38 }),
        familiar,
    ], 'молоко', context({
        preference: 'familiar',
        familiarity: { productIds: new Set([familiar.productId]), titles: new Set() },
    }));
    assert.equal(ranked[0].productId, familiar.productId);
});

test('"cheapest" is not overruled by what the guest usually buys', () => {
    const usual = product({ title: 'Пиво Оболонь світле 0,5 л', price: 34 });
    const ranked = rankCandidates([
        usual,
        product({ title: 'Пиво Чернігівське світле 0,5 л', price: 21 }),
        product({ title: 'Пиво Жигулівське світле 0,5 л', price: 19 }),
    ], 'пиво', context({
        preference: 'cheap',
        familiarity: { productIds: new Set([usual.productId]), titles: new Set() },
    }));
    assert.equal(ranked[0].price, 19, 'the guest asked for the cheapest, not for the usual');
    assert.deepEqual(ranked.map(candidate => candidate.price), [19, 21, 34]);
});

test('familiarity still breaks a tie between equally cheap products', () => {
    const usual = product({ title: 'Пиво Оболонь світле 0,5 л', price: 21 });
    const ranked = rankCandidates([
        product({ title: 'Пиво Чернігівське світле 0,5 л', price: 21 }),
        usual,
    ], 'пиво', context({
        preference: 'cheap',
        familiarity: { productIds: new Set([usual.productId]), titles: new Set() },
    }));
    assert.equal(ranked[0].productId, usual.productId);
});

test('an out-of-stock product never leads, however well it matches', () => {
    const ranked = rankCandidates([
        product({ title: 'Молоко Яготинське 2,5% 900 г', price: 20, inStock: false }),
        product({ title: 'Молоко Селянське 2,5% 900 г', price: 38 }),
    ], 'молоко', context({ preference: 'cheap' }));
    assert.equal(ranked[0].inStock, true);
});

test('relevance outranks the preference — a cheap wrong product stays behind', () => {
    const ranked = rankCandidates([
        product({ title: 'Вода мінеральна Моршинська 1,5 л', price: 20 }),
        product({ title: 'Молоко Яготинське 2,5% 900 г', price: 55 }),
    ], 'молоко', context({ preference: 'cheap' }));
    assert.equal(ranked[0].title, 'Молоко Яготинське 2,5% 900 г');
});
