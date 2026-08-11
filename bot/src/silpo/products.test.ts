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

test('a single-unit special price replaces the shelf price', () => {
    const product = normalizeProduct({
        id: 'p-2',
        title: 'Сир Президент 45% 200 г',
        price: 120,
        companyId: 'c-1',
        specialPrices: [{ price: 99, count: 1, type: 'discount' }],
    });

    assert.ok(product);
    assert.equal(product.price, 99);
    assert.equal(product.oldPrice, 120);
    assert.equal(product.promoLabel, '');
});

test('a multi-buy offer is surfaced as a label, not as the unit price', () => {
    const product = normalizeProduct({
        id: 'p-3',
        title: 'Йогурт Активіа 260 г',
        price: 30,
        companyId: 'c-1',
        specialPrices: [{ price: 25, count: 3, type: 'quantity' }],
    });

    assert.ok(product);
    assert.equal(product.price, 30, 'buying one still costs the shelf price');
    assert.equal(product.promoLabel, '3 шт по 25,00 ₴');
});

test('packaging falls back through title, display ratio and weight fields', () => {
    assert.equal(normalizeProduct({ id: '1', title: 'Кава мелена', price: 1, displayRatio: '250 г' })!.packaging, '250 г');
    assert.equal(normalizeProduct({ id: '2', title: 'Пиво Львівське 2 х 0,5 л', price: 1 })!.packaging, '2 × 0,5 л');
    assert.equal(normalizeProduct({ id: '3', title: 'Банан', price: 1, ratio: 'kg' })!.packaging, '1 кг');
});

test('products without an id or a title are rejected', () => {
    assert.equal(normalizeProduct({ title: 'Без ідентифікатора', price: 10 }), null);
    assert.equal(normalizeProduct({ id: 'p-4', price: 10 }), null);
});

test('formatPrice uses the Ukrainian decimal comma', () => {
    assert.equal(formatPrice(41.9), '41,90 ₴');
    assert.equal(formatPrice(0), '0,00 ₴');
});
