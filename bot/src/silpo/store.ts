import { callMCPTool, firstMcpObject, parseMcpContent } from './mcp';

// What a guest means by "my store" depends on how they get the groceries.
//
// On home delivery they never chose a branch at all — they typed an address,
// and Silpo assigned whichever branch serves it. Showing them that branch's
// street is showing them a warehouse they will never visit. On pickup the
// opposite holds: the branch address *is* the thing they picked.
//
// So every context carries two labels: `shortLabel`, the human answer to
// "where am I shopping", and `branchLabel`, the technical branch behind it.

export type StoreKind = 'delivery' | 'pickup';

export interface StoreContext {
    shoppingCartId: string;
    branchId: string;
    deliveryType: string;
    kind: StoreKind;
    /** The address the guest thinks in: their own on delivery, the shop's on pickup. */
    shortLabel: string;
    /** Full descriptive line: "Доставка · Київ, вул. Хрещатик 1". */
    storeLabel: string;
    /** The branch serving this context — secondary information, never the headline. */
    branchLabel: string;
    /** The branch the guest's Silpo cart is bound to, whichever store we price in. */
    cartBranchId: string;
    cartDeliveryType: string;
    /** Human name of that branch — needed to explain a clash, not to decorate. */
    cartStoreLabel: string;
    /** False once the guest prices the list somewhere other than their cart's store. */
    matchesCart: boolean;
    /** Minimum order value Silpo requires for this delivery context, if any. */
    orderMinimum: number | null;
    deliveryPrice: number | null;
    freeDeliveryFrom: number | null;
    deliveryTemporarilyUnavailable: boolean | null;
}

/** A context the guest can switch to, as the Mini App lists it. */
export interface StoreOption {
    branchId: string;
    deliveryType: string;
    kind: StoreKind;
    /** Headline: the delivery address, or the shop's street on pickup. */
    shortLabel: string;
    /** Secondary line: the branch that serves it, or the city on pickup. */
    branchLabel: string;
    storeLabel: string;
}

export interface StorePreference {
    branchId: string;
    deliveryType: string;
    /** The label the guest picked it by — an address for delivery, a shop for pickup. */
    label?: string;
}

const BRANCH_CACHE_TTL = 6 * 60 * 60 * 1000;
const branchCache = new Map<string, { expiresAt: number; branch: any | null }>();
let catalogCache: { expiresAt: number; branches: any[] } | null = null;

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

function branchIdOf(branch: any): string {
    return String(branch?.branchId || branch?.id || '').trim();
}

export function publicStoreLabel(branch: any): string {
    return [branchCity(branch), branchAddress(branch)].filter(Boolean).join(', ') || 'Магазин Сільпо';
}

export function isPickup(deliveryType: string): boolean {
    return /pickup|самовив/i.test(deliveryType);
}

export function storeKind(deliveryType: string): StoreKind {
    return isPickup(deliveryType) ? 'pickup' : 'delivery';
}

export function deliveryLabel(deliveryType: string): string {
    if (isPickup(deliveryType)) return 'Самовивіз';
    if (/novaposhta/i.test(deliveryType)) return 'Нова пошта';
    if (/wide/i.test(deliveryType)) return 'Широкий асортимент';
    return 'Доставка';
}

/** Reads the address the guest typed, wherever this Silpo payload keeps it. */
export function addressText(source: any): string {
    if (!source || typeof source !== 'object') return '';
    const direct = ['addressName', 'fullAddress', 'addressFull', 'address']
        .map(key => (typeof source[key] === 'string' ? source[key].trim() : ''))
        .find(Boolean);
    if (direct) return direct;
    const street = String(source.street || source.streetName || '').trim();
    const building = String(source.building || source.house || source.houseNumber || '').trim();
    const city = String(source.city || source.locality || '').trim();
    const line = [street, building].filter(Boolean).join(' ');
    return [city, line].filter(Boolean).join(', ');
}

function deliveryAddressOfCart(cart: any): string {
    const shipment = Array.isArray(cart?.shipments) ? cart.shipments[0] : null;
    for (const candidate of [shipment?.deliveryAddress, shipment?.address, cart?.deliveryAddress, cart?.address]) {
        const text = addressText(candidate);
        if (text) return text;
    }
    return addressText(shipment) || '';
}

async function resolveBranch(token: string, branchId: string): Promise<any | null> {
    const cached = branchCache.get(branchId);
    if (cached && cached.expiresAt > Date.now()) return cached.branch;

    // A warm catalogue answers without a round trip; the paged scan below is
    // only for the first lookup of the process.
    let match: any | null = catalogCache && catalogCache.expiresAt > Date.now()
        ? catalogCache.branches.find(branch => branchIdOf(branch) === branchId) || null
        : null;

    for (let offset = 0; offset < 1000 && !match; offset += 50) {
        const response = await callMCPTool(token, 'silpo_list_branches', { limit: 50, offset });
        const branches = branchItems(firstMcpObject(response));
        match = branches.find(branch => branchIdOf(branch) === branchId) || null;
        if (branches.length < 50) break;
    }
    branchCache.set(branchId, { expiresAt: Date.now() + BRANCH_CACHE_TTL, branch: match });
    return match;
}

/** Every Silpo branch, cached — the pickup picker searches this list locally. */
export async function listBranches(token: string): Promise<any[]> {
    if (catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.branches;
    const branches: any[] = [];
    for (let offset = 0; offset < 1000; offset += 50) {
        const response = await callMCPTool(token, 'silpo_list_branches', { limit: 50, offset });
        const page = branchItems(firstMcpObject(response));
        branches.push(...page);
        if (page.length < 50) break;
    }
    catalogCache = { expiresAt: Date.now() + BRANCH_CACHE_TTL, branches };
    return branches;
}

/**
 * Builds a pickable option. `addressLabel` is the guest's own address and takes
 * the headline whenever this is a delivery context.
 */
export function toStoreOption(branch: any, deliveryType: string, addressLabel = ''): StoreOption {
    const kind = storeKind(deliveryType);
    const shop = publicStoreLabel(branch);
    const shortLabel = kind === 'pickup'
        ? (branchAddress(branch) || shop)
        : (addressLabel || shop);
    return {
        branchId: branchIdOf(branch),
        deliveryType,
        kind,
        shortLabel,
        branchLabel: kind === 'pickup' ? branchCity(branch) : `Зі складу ${shop}`,
        storeLabel: `${deliveryLabel(deliveryType)} · ${kind === 'pickup' ? shop : (addressLabel || shop)}`,
    };
}

/** Resolves one branch id into a pickable option without touching the cart. */
export async function branchOption(
    token: string,
    branchId: string,
    deliveryType: string,
    addressLabel = ''
): Promise<StoreOption | null> {
    if (!branchId) return null;
    const branch = await resolveBranch(token, branchId).catch(() => null);
    if (!branch) return null;
    return toStoreOption(branch, deliveryType, addressLabel);
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
 * Derives the shopping context the list is priced in.
 *
 * By default that is the guest's own Silpo cart: prices and availability are
 * store-specific, so every product call must carry the same branch and delivery
 * type the cart already uses. A `preference` overrides where the guest shops
 * while the cart id stays what it is — a Silpo cart cannot be moved between
 * branches, and `matchesCart` is what tells checkout so.
 */
export async function getStoreContext(
    token: string,
    preference?: StorePreference | null
): Promise<StoreContext> {
    const shoppingCartId = await getActiveCartId(token);
    const cart = await getCartPayload(token, shoppingCartId);

    const cartBranchId = String(cart?.shipments?.[0]?.branchId || cart?.branchId || '');
    const cartDeliveryType = String(cart?.deliveryType || 'DeliveryHome');
    if (!cartBranchId) throw new Error('MCP cart context is missing a branch id');

    const branchId = preference?.branchId || cartBranchId;
    const deliveryType = preference?.branchId
        ? (preference.deliveryType || cartDeliveryType)
        : cartDeliveryType;
    const matchesCart = branchId === cartBranchId
        && deliveryType.toLowerCase() === cartDeliveryType.toLowerCase();

    let branch: any | null = null;
    try {
        branch = await resolveBranch(token, branchId);
    } catch (error) {
        console.warn(`[Silpo] Public branch details unavailable for ${branchId}:`, error);
    }

    // On the cart's own delivery context the cart itself knows the address the
    // guest typed; on a picked one we only have the label they picked it by.
    const addressLabel = preference?.branchId
        ? (preference.label || '')
        : deliveryAddressOfCart(cart);
    const option = toStoreOption(branch, deliveryType, addressLabel);

    // Delivery price and order minimum are computed by Silpo for the cart's own
    // context. Reporting them next to another store's prices would be a lie, so
    // they are simply absent while the guest shops elsewhere.
    const calculation = matchesCart ? (cart?.calculation || {}) : {};
    const validations = Array.isArray(calculation?.validations) ? calculation.validations : [];
    const minimum = validations.find((validation: any) => Number(validation?.context?.orderCostMin) > 0);
    const delivery = calculation?.delivery || {};
    const express = delivery?.deliveryExpressByPromise || {};

    const branchLabel = branch ? publicStoreLabel(branch) : '';
    const cartBranch = matchesCart ? branch : await resolveBranch(token, cartBranchId).catch(() => null);

    return {
        shoppingCartId,
        branchId,
        deliveryType,
        kind: option.kind,
        shortLabel: option.shortLabel,
        storeLabel: option.storeLabel,
        branchLabel,
        cartBranchId,
        cartDeliveryType,
        cartStoreLabel: cartBranch ? publicStoreLabel(cartBranch) : '',
        matchesCart,
        orderMinimum: numberOrNull(minimum?.context?.orderCostMin),
        deliveryPrice: numberOrNull(delivery?.total) ?? numberOrNull(express?.price),
        freeDeliveryFrom: numberOrNull(delivery?.freeFrom) ?? numberOrNull(delivery?.freeDeliveryFrom),
        deliveryTemporarilyUnavailable: typeof express?.isTemporarilyUnavailable === 'boolean'
            ? express.isTemporarilyUnavailable
            : null,
    };
}

export interface StoreOptions {
    /** Delivery to an address the guest has saved in Silpo. */
    addresses: StoreOption[];
    /** Shops they collected an order from before. */
    recent: StoreOption[];
    /** Whatever the cart uses today, so it is always offered back. */
    current: StoreOption | null;
}

/**
 * The contexts worth offering without a search: the guest's saved delivery
 * addresses first — that is how they think — then shops they have collected
 * from. Every source is optional; a failing one must not empty the picker.
 */
export async function collectStoreOptions(token: string, context: StoreContext): Promise<StoreOptions> {
    const [orders, addresses] = await Promise.all([
        callMCPTool(token, 'silpo_get_my_online_orders', { limit: 10, offset: 0 }).catch(() => null),
        callMCPTool(token, 'silpo_get_my_delivery_addresses', {}).catch(() => null),
    ]);

    const addressRoot = addresses ? firstMcpObject(addresses) : {};
    const saved = Array.isArray(addressRoot)
        ? addressRoot
        : addressRoot?.items || addressRoot?.addresses || addressRoot?.data || [];
    const addressOptions = (await Promise.all(
        (Array.isArray(saved) ? saved : []).slice(0, 8).map(async (address: any) => {
            const latitude = Number(address?.latitude);
            const longitude = Number(address?.longitude);
            const label = addressText(address);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !label) return null;
            const response = await callMCPTool(token, 'silpo_get_available_delivery_types', { latitude, longitude })
                .catch(() => null);
            if (!response) return null;
            const root = firstMcpObject(response);
            const match = Array.isArray(root?.options)
                ? root.options.find((entry: any) => entry?.deliveryType === 'DeliveryHome' && entry?.branchId)
                : null;
            if (!match?.branchId) return null;
            return branchOption(token, String(match.branchId), 'DeliveryHome', label);
        })
    )).filter(Boolean) as StoreOption[];

    const orderRoot = orders ? firstMcpObject(orders) : {};
    const orderList = Array.isArray(orderRoot?.orders) ? orderRoot.orders : [];
    const seeds = new Map<string, string>();
    for (const order of orderList) {
        const product = Array.isArray(order?.products)
            ? order.products.find((entry: any) => entry?.branchId)
            : null;
        const branchId = String(product?.branchId || order?.branchId || '');
        const deliveryType = String(order?.delivery?.type || '');
        // Only pickup history is worth listing: a past delivery order points at
        // an address that already appears above, through a branch nobody visits.
        if (!branchId || !isPickup(deliveryType) || seeds.has(branchId)) continue;
        seeds.set(branchId, deliveryType);
        if (seeds.size >= 4) break;
    }
    const recent = (await Promise.all(
        [...seeds].map(([branchId, deliveryType]) => branchOption(token, branchId, deliveryType))
    )).filter(Boolean) as StoreOption[];

    const current = await branchOption(token, context.branchId, context.deliveryType, context.shortLabel);
    return { addresses: addressOptions, recent, current };
}

/** Local substring search over the cached branch catalogue, for pickup. */
export async function searchStores(token: string, query: string, limit = 30): Promise<StoreOption[]> {
    const needle = query.toLocaleLowerCase('uk-UA').trim();
    if (needle.length < 2) return [];
    const branches = await listBranches(token);
    const pickup = branches.some(branch => branch?.hasPickup === true)
        ? branches.filter(branch => branch?.hasPickup === true)
        : branches;
    return pickup
        .filter(branch => branchIdOf(branch)
            && publicStoreLabel(branch).toLocaleLowerCase('uk-UA').includes(needle))
        .slice(0, limit)
        .map(branch => toStoreOption(branch, 'SelfPickup'));
}
