import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shapeOf } from './shape';

test('key names and numbers survive, because they are the question', () => {
    assert.deepEqual(shapeOf({ freeFrom: 1000, total: 0, isFree: true }),
        { freeFrom: 1000, total: 0, isFree: true });
});

test('a guest\'s address never reaches the log', () => {
    const shaped = shapeOf({
        deliveryAddress: 'вул. Хрещатик, 1, кв. 25',
        recipientName: 'Артур',
        phone: '+380671234567',
        total: 79,
    }) as Record<string, unknown>;
    assert.equal(shaped.deliveryAddress, '‹str›');
    assert.equal(shaped.recipientName, '‹str›');
    assert.equal(shaped.phone, '‹str›');
    assert.equal(shaped.total, 79);
});

test('a number quoted as a string is still the number we came for', () => {
    assert.deepEqual(shapeOf({ freeFrom: '1000', price: '79,50' }),
        { freeFrom: '1000', price: '79,50' });
});

test('one element is enough to show what an array holds', () => {
    const shaped = shapeOf([{ orderCostMin: 300 }, { orderCostMin: 400 }, { orderCostMin: 500 }]);
    assert.deepEqual(shaped, [{ orderCostMin: 300 }, '‹+2 more›']);
});

test('an empty array says so rather than vanishing', () => {
    assert.deepEqual(shapeOf({ validations: [] }), { validations: [] });
});

test('nesting stops before it can run away', () => {
    let deep: any = 'bottom';
    for (let level = 0; level < 12; level += 1) deep = { nested: deep };
    assert.ok(JSON.stringify(shapeOf(deep)).includes('‹…›'));
});

test('missing values keep their key so an absent threshold is visible', () => {
    assert.deepEqual(shapeOf({ freeFrom: undefined, freeDeliveryFrom: null }),
        { freeFrom: null, freeDeliveryFrom: null });
});

test('a cycle cannot be built out of a JSON payload, but depth still guards it', () => {
    const cyclic: any = { delivery: {} };
    cyclic.delivery.parent = cyclic;
    assert.doesNotThrow(() => JSON.stringify(shapeOf(cyclic)));
});
