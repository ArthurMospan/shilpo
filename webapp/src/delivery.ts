import type { StoreInfo } from './types';

/**
 * What to say about delivery for the basket currently on screen.
 *
 * Silpo prices delivery for what is in the cart, and the list is not in the
 * cart until checkout — so the fee it sends is a true answer to a question
 * about a different basket. Showing it unchanged while the guest piles up
 * products is what made delivery look frozen: the total sailed past the
 * free-delivery threshold and the line beneath it never moved.
 *
 * The threshold is the part of Silpo's answer that stays true whatever is in
 * the basket, so the line is built from that against the total on screen — the
 * way the order minimum already was. The fee itself is still Silpo's number and
 * is never invented here; when it does not apply we say so rather than guessing
 * a new one.
 */
export interface DeliveryState {
    /** Nothing useful is known — say nothing rather than guess. */
    unknown: boolean;
    free: boolean;
    /** Silpo's fee, for as long as it still applies. */
    price: number;
    /** The threshold Silpo reported, or null when this context has none. */
    freeFrom: number | null;
    /** How much more is needed to reach it; 0 once it is reached. */
    toFree: number;
    /** Below what Silpo will accept as an order at all. */
    belowMinimum: boolean;
    missingForMinimum: number;
}

/**
 * What the order will actually weigh.
 *
 * Checkout appends to the cart, so a cart that already holds something counts
 * towards both thresholds — a guest 120 ₴ short of free delivery is not short
 * at all if the cart already carries 300 ₴ of it. Only a cart in the same store
 * can be added to, which is what `matchesCart` decides; anything else is a
 * basket this list will never join.
 */
export function projectedTotal(store: StoreInfo, listTotal: number, cartTotal: number): number {
    return listTotal + (store.matchesCart ? Math.max(0, cartTotal) : 0);
}

export function deliveryState(store: StoreInfo, listTotal: number, cartTotal: number): DeliveryState {
    const projected = projectedTotal(store, listTotal, cartTotal);
    const freeFrom = store.freeDeliveryFrom && store.freeDeliveryFrom > 0 ? store.freeDeliveryFrom : null;
    // A fee Silpo already put at zero is free and stays free: adding more to a
    // basket never brings a delivery charge back.
    const free = store.deliveryPrice === 0 || (freeFrom !== null && projected >= freeFrom);
    const minimum = store.orderMinimum;

    return {
        unknown: store.deliveryPrice === null && freeFrom === null,
        free,
        price: store.deliveryPrice ?? 0,
        freeFrom,
        toFree: freeFrom !== null ? Math.max(0, freeFrom - projected) : 0,
        belowMinimum: minimum !== null && projected < minimum,
        missingForMinimum: minimum !== null ? Math.max(0, minimum - projected) : 0,
    };
}
