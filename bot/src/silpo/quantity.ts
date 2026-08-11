import type { ProductCandidate } from './products';

// How much of a product goes in the cart, in the unit Silpo sells it by.
//
// For almost everything that is a count of packages and the arithmetic is
// boring. Weighted goods are the exception the list never mentions: bread
// labelled 12,47 ₴ / 100 г is priced per kilogram and only leaves the shelf in
// whole 0,8 кг loaves, so "1" against such a product means neither one loaf nor
// one kilogram — it means 0,8, and anything under that is not an order Silpo
// will take.
//
// Every quantity that reaches the cart therefore passes through here: snapped
// to the product's own step, never below its minimum, and converted when the
// guest's list spoke in different units than the shelf does.

/** Silpo's steps have at most three decimals; keep float noise out of them. */
function tidy(value: number): number {
    return Math.round(value * 1000) / 1000;
}

/** One spelling per unit, so "kg", "КГ" and "кілограм" all compare equal. */
export function normalizedUnit(value: unknown): string {
    const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
    const normalized = text.trim().toLowerCase().replace(/[.\s_-]+/g, '');
    if (/^(kg|kilogram|кілограм|кг)$/.test(normalized)) return 'кг';
    if (/^(g|gr|gram|грам|г)$/.test(normalized)) return 'г';
    if (/^(l|liter|litre|літр|л)$/.test(normalized)) return 'л';
    if (/^(ml|milliliter|мілілітр|мл)$/.test(normalized)) return 'мл';
    if (/^(pcs|pc|piece|шт|штука|од)$/.test(normalized)) return 'шт';
    return '';
}

/** Enough steps for any real basket — a ceiling, not a recommendation. */
const MAX_STEPS = 99;

/** The least buyable amount of a product, which is also the stepper's step. */
export function stepOf(product: Pick<ProductCandidate, 'minQuantity'> | null): number {
    const step = product ? Number(product.minQuantity) : 1;
    return Number.isFinite(step) && step > 0 ? tidy(step) : 1;
}

export function unitOf(product: Pick<ProductCandidate, 'saleUnit'> | null): string {
    return product?.saleUnit || 'шт';
}

/**
 * Rounds an amount to something the store will actually sell.
 *
 * Upwards, deliberately: the guest named an amount they need, and a shopping
 * list that quietly delivers less than was asked for is the worse of the two
 * errors. The epsilon is there because 0.6 / 0.3 is 2.0000000000000004 in
 * binary floating point, and ceiling that would hand over three loaves.
 */
export function snapQuantity(
    product: Pick<ProductCandidate, 'minQuantity'> | null,
    requested: unknown
): number {
    const step = stepOf(product);
    const asked = Number(requested);
    if (!Number.isFinite(asked) || asked <= step) return step;
    const steps = Math.min(Math.ceil(asked / step - 1e-9), MAX_STEPS);
    return tidy(Math.max(1, steps) * step);
}

/** The most the stepper will go to, so «більше» stops somewhere sane. */
export function maxQuantity(product: Pick<ProductCandidate, 'minQuantity'> | null): number {
    return tidy(stepOf(product) * MAX_STEPS);
}

/** Grams to kilograms and millilitres to litres — the only conversions groceries need. */
const PER_UNIT: Record<string, number> = { кг: 1000, г: 1, л: 1000, мл: 1 };

function convert(amount: number, from: string, to: string): number | null {
    if (from === to) return amount;
    const source = PER_UNIT[from];
    const target = PER_UNIT[to];
    if (!source || !target) return null;
    // Weight and volume are not each other; 500 мл of cheese is not 0,5 кг.
    const sameFamily = (from === 'кг' || from === 'г') === (to === 'кг' || to === 'г');
    return sameFamily ? (amount * source) / target : null;
}

/** Units that measure an amount rather than count things. */
function isMeasure(unit: string): boolean {
    return unit in PER_UNIT;
}

/**
 * What the guest's list line means in the chosen product's own unit.
 *
 * Three readings, because a number on a shopping list means whatever its unit
 * says it does:
 *
 * - The units line up, so convert. "500 г сиру" against cheese cut by weight is
 *   0,5 кг, raised to the minimum if the counter will not slice that thin.
 * - The list counted things — "2 хліби", or no unit at all — so against weighted
 *   goods it becomes that many minimum portions. Where the minimum is a whole
 *   loaf that is exactly right; where it is smaller it is a floor a visible
 *   stepper can raise, rather than a surprise on the receipt.
 * - The list measured an amount the product is not sold by. Then it counts
 *   nothing: "300 г" against a pre-packed block is one block, and multiplying it
 *   out is how it briefly became ninety-nine of them.
 */
export function quantityFor(
    product: Pick<ProductCandidate, 'minQuantity' | 'saleUnit'> | null,
    item: { quantity: number; unit: string }
): number {
    const asked = Number(item.quantity);
    const count = Number.isFinite(asked) && asked > 0 ? asked : 1;
    const from = normalizedUnit(item.unit);
    const converted = from ? convert(count, from, normalizedUnit(unitOf(product))) : null;
    if (converted !== null) return snapQuantity(product, converted);
    if (isMeasure(from)) return stepOf(product);
    return snapQuantity(product, count * stepOf(product));
}

/** The least this product can cost the guest — one unit of it, or one minimum portion. */
export function startingPrice(product: Pick<ProductCandidate, 'price' | 'minQuantity'>): number {
    return product.price * stepOf(product);
}

/** What a line costs if this product is the one chosen for it. */
export function lineCost(
    product: Pick<ProductCandidate, 'price' | 'minQuantity' | 'saleUnit'>,
    item: { quantity: number; unit: string }
): number {
    return product.price * quantityFor(product, item);
}

/**
 * How an amount reads to a person: "2 шт", "1,6 кг", "800 г". Under a kilogram
 * grams are how Ukrainians say it, and 0,1 кг of cheese is nobody's phrasing.
 */
export function formatAmount(quantity: number, unit: string): string {
    const amount = tidy(Number(quantity) || 0);
    const normalized = normalizedUnit(unit);
    if ((normalized === 'кг' || normalized === 'л') && amount > 0 && amount < 1) {
        const smaller = normalized === 'кг' ? 'г' : 'мл';
        return `${tidy(amount * 1000)} ${smaller}`;
    }
    const printable = Number.isInteger(amount)
        ? String(amount)
        : String(amount).replace('.', ',');
    return `${printable} ${unit || 'шт'}`;
}
