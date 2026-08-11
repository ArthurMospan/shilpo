import { callMCPTool, firstMcpObject, parseMcpContent } from './mcp';

export interface StoreContext {
    shoppingCartId: string;
    branchId: string;
    deliveryType: string;
    city: string;
    address: string;
    storeLabel: string;
    /** Minimum order value Silpo requires for this delivery context, if any. */
    orderMinimum: number | null;
    deliveryPrice: number | null;
    freeDeliveryFrom: number | null;
    deliveryTemporarilyUnavailable: boolean | null;
}

const BRANCH_CACHE_TTL = 6 * 60 * 60 * 1000;
const branchCache = new Map<string, { expiresAt: number; branch: any | null }>();

function branchItems(value: any): any[] {
    if (Array.isArray(value)) return value;
    for (const key of ['branches', 'items', 'data']) {
        if (Array.isArray(value?.[key])) return value[key];
    }
    if (Array.isArray(value?.data?.branches)) return value.data.branches;
    return [];
}

function branchCity(branch: any): string {
    return String(branch?.city || branch?.cityFull || branch?.locality || '').trim();
}

function branchAddress(branch: any): string {
    return String(branch?.address || branch?.addressFull || branch?.streetAddress || '').trim();
}

export function publicStoreLabel(branch: any): string {
    return [branchCity(branch), branchAddress(branch)].filter(Boolean).join(', ') || 'Магазин Сільпо';
}

async function resolveBranch(token: string, branchId: string): Promise<any | null> {
    const cached = branchCache.get(branchId);
    if (cached && cached.expiresAt > Date.now()) return cached.branch;

    let match: any | null = null;
    for (let offset = 0; offset < 1000 && !match; offset += 50) {
        const response = await callMCPTool(token, 'silpo_list_branches', { limit: 50, offset });
        const branches = branchItems(firstMcpObject(response));
        match = branches.find(branch => String(branch?.branchId || branch?.id) === branchId) || null;
        if (branches.length < 50) break;
    }
    branchCache.set(branchId, { expiresAt: Date.now() + BRANCH_CACHE_TTL, branch: match });
    return match;
}

export async function getActiveCartId(token: string): Promise<string> {
    const response = await callMCPTool(token, 'silpo_get_my_shopping_cart', {});
    const root = firstMcpObject(response);
    const cartId = root?.shoppingCartId || root?.cartId || root?.id;
    if (!cartId) throw new Error('MCP did not return an active shopping cart id');
    return String(cartId);
}

export async function getCartPayload(token: string, shoppingCartId: string): Promise<any> {
    const response = await callMCPTool(token, 'silpo_get_shopping_cart_by_id', { shoppingCartId });
    const details = parseMcpContent(response).find(value => value && typeof value === 'object') || {};
    return details?.cart || details;
}

function numberOrNull(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Derives the guest's active shopping context from their live Silpo cart.
 * Prices and availability are store-specific, so every product call must carry
 * the same branch and delivery type the cart already uses.
 */
export async function getStoreContext(token: string): Promise<StoreContext> {
    const shoppingCartId = await getActiveCartId(token);
    const cart = await getCartPayload(token, shoppingCartId);

    const branchId = String(cart?.shipments?.[0]?.branchId || cart?.branchId || '');
    const deliveryType = String(cart?.deliveryType || 'DeliveryHome');
    if (!branchId) throw new Error('MCP cart context is missing a branch id');

    let branch: any | null = null;
    try {
        branch = await resolveBranch(token, branchId);
    } catch (error) {
        console.warn(`[Silpo] Public branch details unavailable for ${branchId}:`, error);
    }

    const calculation = cart?.calculation || {};
    const validations = Array.isArray(calculation?.validations) ? calculation.validations : [];
    const minimum = validations.find((validation: any) => Number(validation?.context?.orderCostMin) > 0);
    const delivery = calculation?.delivery || {};
    const express = delivery?.deliveryExpressByPromise || {};

    return {
        shoppingCartId,
        branchId,
        deliveryType,
        city: branchCity(branch),
        address: branchAddress(branch),
        storeLabel: publicStoreLabel(branch),
        orderMinimum: numberOrNull(minimum?.context?.orderCostMin),
        deliveryPrice: numberOrNull(delivery?.total) ?? numberOrNull(express?.price),
        freeDeliveryFrom: numberOrNull(delivery?.freeFrom) ?? numberOrNull(delivery?.freeDeliveryFrom),
        deliveryTemporarilyUnavailable: typeof express?.isTemporarilyUnavailable === 'boolean'
            ? express.isTemporarilyUnavailable
            : null,
    };
}
