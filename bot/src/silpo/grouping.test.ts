import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectProducts, groupByQuery, normalizeProduct } from './products';
import { dropIrrelevant, rankCandidates, NO_FAMILIARITY } from './ranking';

// The layer between MCP and the picker: pulling products out of a batch
// response and putting each one under the query that asked for it. Everything
// the guest sees passes through here, and until these tests it was the only
// part of the search with no coverage at all.

/** One product the way Silpo nests it: a category and a brand ride along. */
function beer(id: string, title: string, price: number) {
    return {
        id,
        slug: `pyvo-${id}`,
        title,
        price,
        companyId: 'c-1',
        mainImage: `https://cdn.silpo.ua/${id}.png`,
        category: { id: `cat-77`, name: 'Пиво', slug: 'pyvo' },
        trademark: { id: `tm-${id}`, name: 'Оболонь' },
    };
}

function batchResponse(query: string, products: any[]) {
    return {
        result: {
            content: [{ type: 'text', text: JSON.stringify({ queries: [{ query, products }] }) }],
        },
    };
}

test('a nested category is not a product', () => {
    const collected = collectProducts(beer('p-1', 'Пиво Оболонь світле 0,5 л', 24.9));
    assert.equal(collected.length, 1, `expected the beer alone, got ${collected.map(p => p.title ?? p.name).join(' | ')}`);
});

test('the category riding along a beer never reaches the guest as a 0,00 ₴ card', () => {
    const response = batchResponse('пиво', [
        beer('p-1', 'Пиво Оболонь світле 0,5 л', 24.9),
        beer('p-2', 'Пиво Львівське 1715 0,5 л', 31.5),
    ]);

    const raw = groupByQuery(response, ['пиво']).get('пиво') ?? [];
    const candidates = raw.map(normalizeProduct).filter(Boolean) as NonNullable<ReturnType<typeof normalizeProduct>>[];

    assert.deepEqual(
        candidates.map(candidate => candidate.title).sort(),
        ['Пиво Львівське 1715 0,5 л', 'Пиво Оболонь світле 0,5 л']
    );
    assert.ok(candidates.every(candidate => candidate.price > 0), 'a candidate with no price is not something anyone can buy');
});

test('a priceless entry cannot win "cheapest" — that is how junk got to the front', () => {
    const response = batchResponse('пиво', [
        beer('p-1', 'Пиво Оболонь світле 0,5 л', 24.9),
        beer('p-2', 'Пиво Львівське 1715 0,5 л', 31.5),
        beer('p-3', 'Пиво Стела Артуа 0,5 л', 44.9),
    ]);

    const raw = groupByQuery(response, ['пиво']).get('пиво') ?? [];
    const candidates = raw.map(normalizeProduct).filter(Boolean) as NonNullable<ReturnType<typeof normalizeProduct>>[];
    const ranked = rankCandidates(
        dropIrrelevant(candidates, 'пиво'),
        'пиво',
        { preference: 'cheap', familiarity: NO_FAMILIARITY }
    );

    assert.equal(ranked[0]?.title, 'Пиво Оболонь світле 0,5 л', 'the cheapest real beer must lead');
    assert.equal(ranked.length, 3);
});

test('a query bucket is found even when Silpo echoes the term differently', () => {
    const response = batchResponse('Пиво  ', [beer('p-1', 'Пиво Оболонь світле 0,5 л', 24.9)]);
    assert.equal(groupByQuery(response, ['пиво']).get('пиво')?.length, 1);
});
