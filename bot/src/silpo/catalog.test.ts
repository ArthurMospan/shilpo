import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    fetchCatalogProduct,
    MAX_PAGE,
    MAX_PRODUCTS_PER_QUERY,
    searchCatalogAll,
    searchCatalogPage,
} from './catalog';

const context = { branchId: 'branch-1', deliveryType: 'DeliveryHome' };

interface Call { path: string; params: URLSearchParams }

/**
 * Stands in for Silpo's storefront, recording what was asked of it. The point
 * of these tests is the request: whether products come back at all depends on
 * which search parameter is used, and no assertion about ranking can catch that.
 */
function fakeStorefront(pages: (query: string, offset: number) => { items: any[]; total: number }) {
    const calls: Call[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
        const url = new URL(String(input));
        calls.push({ path: url.pathname, params: url.searchParams });
        const page = pages(
            url.searchParams.get('searchV2') || url.searchParams.get('search') || '',
            Number(url.searchParams.get('offset') || 0)
        );
        return new Response(JSON.stringify(page), { status: 200 });
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = original; } };
}

function row(id: number, extra: Record<string, unknown> = {}) {
    return { id: `p-${id}`, title: `Пиво ${id}`, price: 20 + id, ratio: 'шт', stock: 5, ...extra };
}

test('the catalogue is searched with searchV2, the parameter silpo.ua itself sends', async () => {
    // `search` answered "пиво" with 126 products and no Stella Artois at all,
    // where `searchV2` answered with 386 and put it first. Anything that quietly
    // reverts this makes obvious products unfindable again.
    const store = fakeStorefront(() => ({ items: [row(1)], total: 1 }));
    try {
        await searchCatalogPage(context, 'пиво', { limit: 10, offset: 0 });
    } finally {
        store.restore();
    }

    assert.equal(store.calls.length, 1);
    assert.equal(store.calls[0].params.get('searchV2'), 'пиво');
    assert.equal(store.calls[0].params.get('search'), null, 'the older matcher misses products it contains');
    assert.equal(store.calls[0].params.get('deliveryType'), 'DeliveryHome');
    assert.ok(store.calls[0].path.includes('branch-1'), 'prices are per branch');
});

test('a shelf wider than one page is fetched whole', async () => {
    const total = 386;
    const store = fakeStorefront((_query, offset) => ({
        items: Array.from({ length: Math.min(MAX_PAGE, total - offset) }, (_, index) => row(offset + index)),
        total,
    }));
    let page;
    try {
        page = await searchCatalogAll(context, 'пиво');
    } finally {
        store.restore();
    }

    assert.equal(page.total, total);
    assert.equal(page.items.length, total, 'ranking cannot pick the cheapest off a shelf it half saw');
    assert.deepEqual(store.calls.map(call => call.params.get('offset')), ['0', '100', '200', '300']);
});

test('a shelf is capped rather than paged forever', async () => {
    const store = fakeStorefront((_query, offset) => ({
        items: Array.from({ length: MAX_PAGE }, (_, index) => row(offset + index)),
        total: 5000,
    }));
    let page;
    try {
        page = await searchCatalogAll(context, 'вода');
    } finally {
        store.restore();
    }

    assert.equal(page.items.length, MAX_PRODUCTS_PER_QUERY);
    assert.equal(page.total, 5000, 'the store still reports what it really has');
});

test('a single product is looked up with the array form the endpoint accepts', async () => {
    // A bare `productsIds=` answers 500; this is how a choice made on the fourth
    // page of the shelf gets priced by Silpo rather than trusted from the phone.
    const store = fakeStorefront(() => ({ items: [row(7, { title: 'Пиво Stella Artois світле' })], total: 1 }));
    let product;
    try {
        product = await fetchCatalogProduct(context, 'p-7');
    } finally {
        store.restore();
    }

    assert.equal(product?.title, 'Пиво Stella Artois світле');
    assert.deepEqual(store.calls[0].params.getAll('productsIds[]'), ['p-7']);
});

test('a product the store no longer has comes back as nothing', async () => {
    const store = fakeStorefront(() => ({ items: [], total: 0 }));
    try {
        assert.equal(await fetchCatalogProduct(context, 'gone'), null);
        assert.equal(await fetchCatalogProduct(context, ''), null, 'and no id is not a lookup at all');
    } finally {
        store.restore();
    }
    assert.equal(store.calls.length, 1, 'an empty id never reaches Silpo');
});

test('one failing page does not lose the pages that worked', async () => {
    const total = 250;
    const store = fakeStorefront((_query, offset) => {
        if (offset === 100) throw new Error('Silpo hiccuped');
        return {
            items: Array.from({ length: Math.min(MAX_PAGE, total - offset) }, (_, index) => row(offset + index)),
            total,
        };
    });
    let page;
    try {
        page = await searchCatalogAll(context, 'пиво');
    } finally {
        store.restore();
    }

    assert.equal(page.items.length, 150, 'the first and last pages survive');
});
