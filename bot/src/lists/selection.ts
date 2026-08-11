import type { ProductCandidate } from '../silpo/products';
import type { ListItemRecord } from './repository';

export interface SelectionLine {
    item: ListItemRecord;
    product: ProductCandidate | null;
    quantity: number;
    lineTotal: number;
}

export interface Selection {
    lines: SelectionLine[];
    /** Lines with a chosen product — the ones that will reach the cart. */
    chosen: SelectionLine[];
    total: number;
    productCount: number;
}

/**
 * Turns stored list rows into the basket the guest is about to confirm.
 * Dropped lines and lines whose selection no longer exists in the candidate
 * set are excluded, so a stale product id can never reach the Silpo cart.
 */
export function buildSelection(items: ListItemRecord[]): Selection {
    const lines: SelectionLine[] = items
        .filter(item => !item.dropped)
        .map(item => {
            const product = item.candidates.find(candidate => candidate.productId === item.selectedProductId) || null;
            const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
            return { item, product, quantity, lineTotal: product ? product.price * quantity : 0 };
        });

    const chosen = lines.filter(line => line.product !== null);
    return {
        lines,
        chosen,
        total: chosen.reduce((sum, line) => sum + line.lineTotal, 0),
        productCount: chosen.reduce((sum, line) => sum + line.quantity, 0),
    };
}
