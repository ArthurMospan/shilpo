import type { ProductCandidate } from '../silpo/products';
import { snapQuantity, unitOf } from '../silpo/quantity';
import type { ListItemRecord } from './repository';

export interface SelectionLine {
    item: ListItemRecord;
    product: ProductCandidate | null;
    /** In the chosen product's sale unit: pieces, or kilograms when sold by weight. */
    quantity: number;
    /** What that unit is, so the amount can be printed without guessing. */
    unit: string;
    lineTotal: number;
}

export interface Selection {
    lines: SelectionLine[];
    /** Lines with a chosen product — the ones that will reach the cart. */
    chosen: SelectionLine[];
    total: number;
    /** Products going into the cart. Counted, never summed: 0,8 кг is one product. */
    productCount: number;
}

/**
 * Turns stored list rows into the basket the guest is about to confirm.
 * Dropped lines and lines whose selection no longer exists in the candidate
 * set are excluded, so a stale product id can never reach the Silpo cart.
 *
 * Quantities are snapped to what the chosen product can actually be bought in.
 * Rounding them to whole numbers, as this used to, is only right while every
 * product is a package — against bread sold in 0,8 кг loaves it turned the
 * guest's choice into a kilogram.
 */
export function buildSelection(items: ListItemRecord[]): Selection {
    const lines: SelectionLine[] = items
        .filter(item => !item.dropped)
        .map(item => {
            const product = item.candidates.find(candidate => candidate.productId === item.selectedProductId) || null;
            const quantity = snapQuantity(product, item.quantity);
            return {
                item,
                product,
                quantity,
                unit: unitOf(product),
                lineTotal: product ? product.price * quantity : 0,
            };
        });

    const chosen = lines.filter(line => line.product !== null);
    return {
        lines,
        chosen,
        total: chosen.reduce((sum, line) => sum + line.lineTotal, 0),
        productCount: chosen.length,
    };
}
