import type { ListItemRecord } from '../lists/repository';
import { formatPrice, type ProductCandidate } from '../silpo/products';

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function formatMoney(value: number): string {
    return formatPrice(value);
}

/** "2 шт", "1,5 кг", or an empty string when the amount is a plain single unit. */
export function formatQuantity(item: Pick<ListItemRecord, 'quantity' | 'unit'>): string {
    const amount = Number(item.quantity) || 1;
    const printable = Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace('.', ',');
    const unit = item.unit || 'шт';
    return `${printable} ${unit}`;
}

export function itemLabel(item: Pick<ListItemRecord, 'query' | 'note'>): string {
    return [item.query, item.note].filter(Boolean).join(', ');
}

/** Compact one-line summary used in the recognized-list preview. */
export function itemPreviewLine(item: ListItemRecord): string {
    const label = escapeHtml(itemLabel(item));
    const amount = item.needsQuantity ? '' : ` — <b>${escapeHtml(formatQuantity(item))}</b>`;
    return `• ${label}${amount}`;
}

export function productLine(product: ProductCandidate): string {
    const parts = [`<b>${escapeHtml(product.title)}</b>`];
    if (product.packaging) parts.push(escapeHtml(product.packaging));
    const price = product.oldPrice > product.price
        ? `${formatMoney(product.price)} <s>${formatMoney(product.oldPrice)}</s>`
        : formatMoney(product.price);
    return `${parts.join(' · ')}\n${price}`;
}

export function pluralizeItems(count: number): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'позиція';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'позиції';
    return 'позицій';
}

export function pluralizeDetails(count: number): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'деталь';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'деталі';
    return 'деталей';
}

export function pluralizeProducts(count: number): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'товар';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'товари';
    return 'товарів';
}
