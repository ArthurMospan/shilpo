import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPrice, normalizeProduct } from './products';

test('normalizeProduct keeps the price the guest actually pays', () => {
    const product = normalizeProduct({
        id: 'p-1',
        slug: 'moloko-yagotynske-2-5-900g-123',
        title: 'Молоко Яготинське 2,5% 900 г',
        price: 41.9,
        oldPrice: 47.9,
        companyId: 'c-1',
        externalProductId: 123,
        image: 'https://cdn.silpo.ua/moloko.png',
    });

    assert.ok(product);
    assert.equal(product.price, 41.9);
    assert.equal(product.oldPrice, 47.9);
    assert.equal(product.hasPromo, true);
    assert.equal(product.packaging, '900 г');
    assert.equal(product.url, 'https://silpo.ua/product/moloko-yagotynske-2-5-900g-123');
});

test('a special price the smallest purchase already earns replaces the shelf price', () => {
    const product = normalizeProduct({
        id: 'p-2',
        title: 'Сир Президент 45% 200 г',
        price: 120,
        companyId: 'c-1',
        specialPrices: [{ price: 99, count: 1, type: 'from' }],
    });

    assert.ok(product);
    assert.equal(product.price, 99);
    assert.equal(product.oldPrice, 120);
    assert.equal(product.promoLabel, '');
});

test('a threshold offer is surfaced as a condition, not charged as the unit price', () => {
    // Every packaged offer in the branch starts at two or more, and quoting the
    // bulk price to someone buying one was the app undercutting the receipt.
    const product = normalizeProduct({
        id: 'p-3',
        title: 'Йогурт Активіа 260 г',
        price: 30,
        companyId: 'c-1',
        specialPrices: [{ price: 25, count: 3, type: 'from' }],
    });

    assert.ok(product);
    assert.equal(product.price, 30, 'buying one still costs the shelf price');
    assert.equal(product.promoLabel, 'від 3 шт — 25,00 ₴');
});

test('a weighted offer is read on the shelf label\'s scale, not the kilogram\'s', () => {
    // Silpo quotes 46,90 ₴ per 100 г on sausage priced 529 ₴ per кг. Taken as a
    // kilogram price it made cured sausage the cheapest thing in the shop.
    const product = normalizeProduct({
        id: 'p-8',
        title: 'Ковбаса «Премія»® Лікарська варена',
        price: 529,
        ratio: 'кг',
        weighted: true,
        addToBasketStep: 0.5,
        shelfPrice: 52.9,
        shelfUnit: '100г',
        specialPrices: [{ price: 46.9, count: 0.5, type: 'from' }],
    });

    assert.ok(product);
    assert.equal(product.price, 469, '46,90 ₴ per 100 г is 469 ₴ a kilogram');
    assert.equal(product.oldPrice, 529);
    assert.equal(product.shelfPrice, 46.9, 'the label follows the promo');
    assert.equal(product.shelfOldPrice, 52.9);
    assert.equal(product.promoLabel, '', 'half a kilo is the minimum, so this simply applies');
});

test('a weighted offer above the minimum stays a condition', () => {
    const product = normalizeProduct({
        id: 'p-9',
        title: 'Ковбаса «Фарро» «Молочна»',
        price: 569,
        ratio: 'кг',
        weighted: true,
        addToBasketStep: 0.1,
        shelfPrice: 56.9,
        shelfUnit: '100г',
        specialPrices: [{ price: 46.9, count: 0.4, type: 'from' }],
    });

    assert.ok(product);
    assert.equal(product.price, 569, '100 г does not earn the 400 г price');
    assert.equal(product.promoLabel, 'від 400 г — 46,90 ₴/100 г');
});

test('packaging falls back through title, display ratio and weight fields', () => {
    assert.equal(normalizeProduct({ id: '1', title: 'Кава мелена', price: 1, displayRatio: '250 г' })!.packaging, '250 г');
    assert.equal(normalizeProduct({ id: '2', title: 'Пиво Львівське 2 х 0,5 л', price: 1 })!.packaging, '2 × 0,5 л');
    assert.equal(normalizeProduct({ id: '3', title: 'Банан', price: 1, ratio: 'kg' })!.packaging, '1 кг');
});

test('a weighted product is priced by its sale unit, not by its shelf label', () => {
    // Silpo prints 12,47 ₴ / 100 г on bread it charges 124,74 ₴ a kilogram for.
    // Reading the label as the price made it look ten times cheaper than it is.
    const product = normalizeProduct({
        id: 'p-5',
        slug: 'khlib-podovyi-grechanyi-815252',
        title: 'Хліб подовий гречаний',
        price: 124.74,
        oldPrice: 154,
        ratio: 'кг',
        weighted: true,
        addToBasketStep: 0.8,
        shelfPrice: 12.47,
        shelfUnit: '100г',
    });

    assert.ok(product);
    assert.equal(product.price, 124.74);
    assert.equal(product.oldPrice, 154);
    assert.equal(product.saleUnit, 'кг');
    assert.equal(product.weighted, true);
    assert.equal(product.minQuantity, 0.8, 'less than one loaf is not for sale');
    assert.equal(product.shelfPrice, 12.47);
    assert.equal(product.shelfOldPrice, 15.4, 'the crossed-out price is on the label scale too');
    assert.equal(product.shelfUnit, '100 г');
    assert.equal(product.packaging, '', 'a loaf cut to order has no pack size');
});

test('a packaged product carries no second price to show', () => {
    const product = normalizeProduct({
        id: 'p-6',
        title: 'Пиво Stella Artois світле',
        price: 29.99,
        ratio: 'шт',
        weighted: false,
        addToBasketStep: 1,
        shelfPrice: 29.99,
        shelfUnit: '0,33л',
    });

    assert.ok(product);
    assert.equal(product.saleUnit, 'шт');
    assert.equal(product.minQuantity, 1);
    assert.equal(product.shelfPrice, 0, 'a label equal to the price is not a label');
    assert.equal(product.shelfUnit, '');
});

test('a source that says nothing about weight is treated as packaged', () => {
    // The MCP fallback describes bananas priced per kilogram without ever
    // saying they are weighed, and guessing would turn a count into kilograms.
    const product = normalizeProduct({ id: 'p-7', title: 'Банан', price: 1, ratio: 'kg' });

    assert.ok(product);
    assert.equal(product.weighted, false);
    assert.equal(product.minQuantity, 1);
});

test('products without an id or a title are rejected', () => {
    assert.equal(normalizeProduct({ title: 'Без ідентифікатора', price: 10 }), null);
    assert.equal(normalizeProduct({ id: 'p-4', price: 10 }), null);
});

test('formatPrice uses the Ukrainian decimal comma', () => {
    assert.equal(formatPrice(41.9), '41,90 ₴');
    assert.equal(formatPrice(0), '0,00 ₴');
});
