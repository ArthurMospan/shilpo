import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliveryState, projectedTotal } from './delivery';
import type { StoreInfo } from './types';

function store(overrides: Partial<StoreInfo> = {}): StoreInfo {
    return {
        branchId: 'b-1',
        deliveryType: 'DeliveryHome',
        kind: 'delivery',
        shortLabel: 'Дім',
        storeLabel: 'Доставка · Дім',
        branchLabel: '',
        cartBranchId: 'b-1',
        cartDeliveryType: 'DeliveryHome',
        cartStoreLabel: '',
        matchesCart: true,
        orderMinimum: null,
        deliveryPrice: 79,
        freeDeliveryFrom: 1000,
        deliveryTemporarilyUnavailable: null,
        ...overrides,
    } as StoreInfo;
}

test('delivery goes free the moment the basket reaches the threshold', () => {
    // The reported bug: the total sailed past 1000 ₴ and the line never moved.
    assert.equal(deliveryState(store(), 999, 0).free, false);
    assert.equal(deliveryState(store(), 1000, 0).free, true);
});

test('it says how much is still missing, and stops at zero', () => {
    assert.equal(deliveryState(store(), 880, 0).toFree, 120);
    assert.equal(deliveryState(store(), 1400, 0).toFree, 0, 'never a negative shortfall');
});

test('what the cart already holds counts towards the threshold', () => {
    // Checkout appends, so a guest 120 ₴ short is not short at all when the
    // cart already carries 300 ₴ of the same order.
    const state = deliveryState(store(), 880, 300);
    assert.equal(state.free, true);
    assert.equal(state.toFree, 0);
});

test('a cart in another store is a basket this list will never join', () => {
    const elsewhere = store({ matchesCart: false });
    assert.equal(projectedTotal(elsewhere, 880, 300), 880);
    assert.equal(deliveryState(elsewhere, 880, 300).free, false);
});

test('a fee Silpo already put at zero is free, and stays free', () => {
    // `numberOrNull` used to report 0 as "no number", which hid the line at the
    // one moment it had good news.
    const state = deliveryState(store({ deliveryPrice: 0, freeDeliveryFrom: null }), 10, 0);
    assert.equal(state.free, true);
    assert.equal(state.unknown, false);
});

test('a context with neither a fee nor a threshold says nothing at all', () => {
    const state = deliveryState(store({ deliveryPrice: null, freeDeliveryFrom: null }), 500, 0);
    assert.equal(state.unknown, true);
});

test('pickup has no threshold, so nothing is ever owed towards one', () => {
    const state = deliveryState(store({ deliveryPrice: null, freeDeliveryFrom: null }), 40, 0);
    assert.equal(state.toFree, 0);
    assert.equal(state.free, false);
});

test('the order minimum counts the same basket the threshold does', () => {
    const strict = store({ orderMinimum: 500, freeDeliveryFrom: null });
    assert.equal(deliveryState(strict, 200, 0).belowMinimum, true);
    assert.equal(deliveryState(strict, 200, 0).missingForMinimum, 300);
    assert.equal(deliveryState(strict, 200, 350).belowMinimum, false,
        'the cart already covers it — telling the guest otherwise sends them shopping for nothing');
});

test('Silpo\'s fee is reported, never invented', () => {
    assert.equal(deliveryState(store({ deliveryPrice: 129 }), 100, 0).price, 129);
});
