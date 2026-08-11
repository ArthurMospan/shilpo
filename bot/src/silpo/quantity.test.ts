import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    formatAmount,
    lineCost,
    maxQuantity,
    quantityFor,
    snapQuantity,
    startingPrice,
    stepOf,
} from './quantity';
import type { ProductCandidate } from './products';

function product(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
    return {
        productId: 'p-1',
        externalProductId: 1,
        companyId: 'c-1',
        slug: 'p-1',
        title: 'Товар',
        brand: '',
        imageUrl: '',
        price: 40,
        oldPrice: 0,
        packaging: '',
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
        ...overrides,
    };
}

/** Bread at 124,74 ₴/кг that Silpo only cuts in whole 0,8 кг loaves. */
const bread = product({ price: 124.74, saleUnit: 'кг', weighted: true, minQuantity: 0.8 });
const cheese = product({ price: 599, saleUnit: 'кг', weighted: true, minQuantity: 0.25 });

test('a packaged product steps one piece at a time', () => {
    assert.equal(stepOf(product()), 1);
    assert.equal(snapQuantity(product(), 3), 3);
    assert.equal(snapQuantity(product(), 0), 1, 'nothing is not an order');
});

test('the minimum is the floor, however little is asked for', () => {
    assert.equal(snapQuantity(bread, 0.1), 0.8);
    assert.equal(snapQuantity(bread, 0.8), 0.8);
    assert.equal(snapQuantity(cheese, 0.05), 0.25);
});

test('an amount between steps rounds up, never down', () => {
    assert.equal(snapQuantity(bread, 1), 1.6, 'a kilogram means two loaves');
    assert.equal(snapQuantity(cheese, 0.6), 0.75);
    assert.equal(snapQuantity(cheese, 0.5), 0.5, 'an exact multiple is left alone');
});

test('exact multiples survive binary floating point', () => {
    // 0.6 / 0.3 is 2.0000000000000004, which would have bought a third portion.
    const portioned = product({ saleUnit: 'кг', weighted: true, minQuantity: 0.3 });
    assert.equal(snapQuantity(portioned, 0.6), 0.6);
    assert.equal(snapQuantity(portioned, 0.9), 0.9);
});

test('a list line in grams becomes kilograms of what is cut to order', () => {
    assert.equal(quantityFor(cheese, { quantity: 500, unit: 'г' }), 0.5);
    assert.equal(quantityFor(cheese, { quantity: 2, unit: 'кг' }), 2);
    assert.equal(quantityFor(cheese, { quantity: 100, unit: 'г' }), 0.25, 'raised to the minimum');
});

test('a bare count against weighted goods buys that many minimum portions', () => {
    assert.equal(quantityFor(bread, { quantity: 1, unit: 'шт' }), 0.8, 'one loaf');
    assert.equal(quantityFor(bread, { quantity: 2, unit: 'шт' }), 1.6, 'two loaves, not two kilograms');
    assert.equal(quantityFor(bread, { quantity: 1, unit: '' }), 0.8);
});

test('a weight the product is not sold by counts one of it, not that many', () => {
    // "300 г" against a pre-packed block is one block. Multiplying it out is how
    // "сир, 300 г" briefly asked for ninety-nine packs of cheese.
    assert.equal(quantityFor(product(), { quantity: 300, unit: 'г' }), 1);
    assert.equal(quantityFor(product(), { quantity: 2, unit: 'кг' }), 1);
});

test('litres and millilitres convert, weight and volume do not', () => {
    const olives = product({ saleUnit: 'л', weighted: true, minQuantity: 0.1 });
    assert.equal(quantityFor(olives, { quantity: 500, unit: 'мл' }), 0.5);
    // 2 л of cheese is not two kilograms of it, so it is not any number of them.
    assert.equal(quantityFor(cheese, { quantity: 2, unit: 'л' }), 0.25);
});

test('what a product costs is the least of it that can be bought', () => {
    assert.equal(startingPrice(product()), 40);
    assert.equal(startingPrice(bread).toFixed(2), '99.79', '0,8 кг at 124,74 ₴/кг');
    assert.equal(startingPrice(cheese).toFixed(2), '149.75');
});

test('a line costs the product times the amount it is sold in', () => {
    assert.equal(lineCost(bread, { quantity: 2, unit: 'шт' }).toFixed(2), '199.58');
    assert.equal(lineCost(product(), { quantity: 3, unit: 'шт' }), 120);
});

test('amounts read the way they are said out loud', () => {
    assert.equal(formatAmount(2, 'шт'), '2 шт');
    assert.equal(formatAmount(0.8, 'кг'), '800 г');
    assert.equal(formatAmount(1.6, 'кг'), '1,6 кг');
    assert.equal(formatAmount(0.25, 'кг'), '250 г');
    assert.equal(formatAmount(1, 'кг'), '1 кг');
    assert.equal(formatAmount(0.5, 'л'), '500 мл');
});

test('the stepper stops at ninety-nine steps, whatever a step is', () => {
    assert.equal(maxQuantity(product()), 99);
    assert.equal(maxQuantity(cheese), 24.75);
    assert.equal(snapQuantity(cheese, 1000), 24.75);
});
