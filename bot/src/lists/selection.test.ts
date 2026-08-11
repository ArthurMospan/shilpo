import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSelection } from './selection';
import type { ListItemRecord } from './repository';
import type { ProductCandidate } from '../silpo/products';

function candidate(productId: string, price: number): ProductCandidate {
    return {
        productId,
        externalProductId: 1,
        companyId: 'c-1',
        slug: productId,
        title: productId,
        brand: '',
        imageUrl: '',
        price,
        oldPrice: 0,
        packaging: '',
        priceUnit: '',
        inStock: true,
        hasPromo: false,
        promoLabel: '',
        url: '',
    };
}

function item(overrides: Partial<ListItemRecord>): ListItemRecord {
    return {
        itemId: 'i-1',
        listId: 'l-1',
        position: 0,
        rawText: 'молоко',
        query: 'молоко',
        quantity: 1,
        unit: 'шт',
        note: '',
        needsQuantity: false,
        clarification: null,
        candidates: [],
        selectedProductId: '',
        dropped: false,
        ...overrides,
    };
}

test('the total multiplies each chosen product by its quantity', () => {
    const selection = buildSelection([
        item({ itemId: 'a', candidates: [candidate('p1', 41.9)], selectedProductId: 'p1', quantity: 2 }),
        item({ itemId: 'b', candidates: [candidate('p2', 27.5)], selectedProductId: 'p2', quantity: 1 }),
    ]);

    assert.equal(selection.chosen.length, 2);
    assert.equal(selection.productCount, 3);
    assert.equal(selection.total.toFixed(2), '111.30');
});

test('dropped lines never reach the cart', () => {
    const selection = buildSelection([
        item({ itemId: 'a', candidates: [candidate('p1', 40)], selectedProductId: 'p1', dropped: true }),
        item({ itemId: 'b', candidates: [candidate('p2', 10)], selectedProductId: 'p2' }),
    ]);

    assert.equal(selection.lines.length, 1);
    assert.equal(selection.total, 10);
});

test('a selection pointing at a product that is no longer offered is ignored', () => {
    const selection = buildSelection([
        item({ itemId: 'a', candidates: [candidate('p1', 40)], selectedProductId: 'stale-id' }),
    ]);

    assert.equal(selection.chosen.length, 0);
    assert.equal(selection.total, 0);
    assert.equal(selection.lines[0].product, null, 'the line still shows so the guest can re-pick');
});

test('a broken quantity falls back to one unit rather than zeroing the line', () => {
    const selection = buildSelection([
        item({ itemId: 'a', candidates: [candidate('p1', 12.5)], selectedProductId: 'p1', quantity: 0 }),
    ]);

    assert.equal(selection.productCount, 1);
    assert.equal(selection.total, 12.5);
});
