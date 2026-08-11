import type { ProductCandidate } from './types';

// The stepper has to count in whatever unit Silpo sells the chosen product by.
//
// A pack of milk goes up one at a time. Bread cut to order is priced per
// kilogram, labelled per 100 г and only leaves the shelf in whole 0,8 кг
// loaves — so the same «+» has to add 0,8 there and the same «1» has to read
// «800 г». These rules mirror bot/src/silpo/quantity.ts, which is the authority:
// the server re-snaps every amount it is sent.

/** Silpo's steps go down to 0,05 кг; three decimals covers all of them. */
function tidy(value: number): number {
    return Math.round(value * 1000) / 1000;
}

const MAX_STEPS = 99;

export function stepOf(product: ProductCandidate | null): number {
    const step = product ? Number(product.minQuantity) : 1;
    return Number.isFinite(step) && step > 0 ? tidy(step) : 1;
}

export function unitOf(product: ProductCandidate | null): string {
    return product?.saleUnit || 'шт';
}

export function maxQuantity(product: ProductCandidate | null): number {
    return tidy(stepOf(product) * MAX_STEPS);
}

/**
 * Rounds an amount up to something buyable — never below the minimum, and
 * always a whole number of steps. The epsilon keeps 0.6 / 0.3 from reading as
 * 2.0000000000000004 and handing over a third loaf.
 */
export function snapQuantity(product: ProductCandidate | null, requested: number): number {
    const step = stepOf(product);
    if (!Number.isFinite(requested) || requested <= step) return step;
    const steps = Math.min(Math.ceil(requested / step - 1e-9), MAX_STEPS);
    return tidy(Math.max(1, steps) * step);
}

/**
 * Where the stepper lands when the guest swaps in a product sold differently.
 *
 * Same unit, same amount. Otherwise the number was counting something the new
 * product is not: 1,6 кг of a loaf cut to order says nothing about how many
 * pre-packed loaves to take, so the amount starts again at the minimum. The
 * server applies the same reading, and it is the one that decides.
 */
export function requantify(
    product: ProductCandidate | null,
    quantity: number,
    unit: string
): number {
    const from = unit.trim().toLowerCase();
    const to = unitOf(product).trim().toLowerCase();
    if (from === to) return snapQuantity(product, quantity);
    return from === 'шт' || !from ? snapQuantity(product, quantity * stepOf(product)) : stepOf(product);
}

/** "2 шт", "1,6 кг", "800 г" — grams under a kilogram, because that is how it is said. */
export function formatAmount(quantity: number, unit: string): string {
    const amount = tidy(Number(quantity) || 0);
    const normalized = unit.trim().toLowerCase();
    if ((normalized === 'кг' || normalized === 'л') && amount > 0 && amount < 1) {
        return `${tidy(amount * 1000)} ${normalized === 'кг' ? 'г' : 'мл'}`;
    }
    const printable = Number.isInteger(amount) ? String(amount) : String(amount).replace('.', ',');
    return `${printable} ${unit || 'шт'}`;
}
