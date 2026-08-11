import { callMCPTool } from './mcp';
import { getCartPayload } from './store';

export const SILPO_BASKET_URL = 'https://silpo.ua/basket';
export const SILPO_CHECKOUT_URL = 'https://silpo.ua/checkout';

export interface CartLine {
    productId: string;
    title: string;
    quantity: number;
    price: number;
    total: number;
    imageUrl: string;
}

export interface CartSummary {
    shoppingCartId: string;
    lines: CartLine[];
    itemCount: number;
    total: number;
    isEmpty: boolean;
}

function numberOf(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function textOf(source: any, keys: string[]): string {
    for (const key of keys) {
        const value = source?.[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

/** Cart products live under shipments; older payloads expose them at the root. */
function cartProducts(cart: any): any[] {
    const shipments = Array.isArray(cart?.shipments) ? cart.shipments : [];
    const fromShipments = shipments.flatMap((shipment: any) =>
        Array.isArray(shipment?.products) ? shipment.products : []);
    if (fromShipments.length) return fromShipments;
    for (const key of ['products', 'items', 'lines']) {
        if (Array.isArray(cart?.[key])) return cart[key];
    }
    return [];
}

export async function getCartSummary(token: string, shoppingCartId: string): Promise<CartSummary> {
    const cart = await getCartPayload(token, shoppingCartId);
    const lines: CartLine[] = cartProducts(cart).map((product: any) => {
        const quantity = numberOf(product?.quantity ?? product?.count) || 1;
        const price = numberOf(product?.price ?? product?.currentPrice ?? product?.unitPrice);
        return {
            productId: String(product?.productId ?? product?.id ?? ''),
            title: textOf(product, ['title', 'name', 'productName']) || 'Товар',
            quantity,
            price,
            total: numberOf(product?.total ?? product?.sum ?? product?.totalPrice) || price * quantity,
            imageUrl: textOf(product, ['image', 'imageUrl', 'image_url']),
        };
    }).filter(line => line.productId);

    const calculatedTotal = numberOf(cart?.calculation?.productsTotal)
        || numberOf(cart?.calculation?.total)
        || lines.reduce((sum, line) => sum + line.total, 0);

    return {
        shoppingCartId,
        lines,
        itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
        total: calculatedTotal,
        isEmpty: lines.length === 0,
    };
}

export interface CartAddition {
    productId: string;
    companyId: string;
    quantity: number;
}

export async function addProductsToCart(
    token: string,
    shoppingCartId: string,
    branchId: string,
    additions: CartAddition[]
): Promise<number> {
    const products = additions
        .filter(addition => addition.productId && addition.companyId)
        .map(addition => ({
            productId: String(addition.productId),
            companyId: String(addition.companyId),
            branchId: String(branchId),
            quantity: Math.max(1, Math.round(Number(addition.quantity) || 1)),
            // The guest asked to add these on top of whatever is already there;
            // replacement is handled by clearing the cart first, never by
            // silently overwriting a line's quantity.
            addQuantity: true,
        }));
    if (!products.length) return 0;

    await callMCPTool(token, 'silpo_add_or_update_cart_products', { shoppingCartId, products });
    return products.length;
}

export async function clearCart(token: string, shoppingCartId: string): Promise<void> {
    await callMCPTool(token, 'silpo_clear_shopping_cart', { shoppingCartId });
}
