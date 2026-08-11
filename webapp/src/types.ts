export interface ProductCandidate {
    productId: string;
    externalProductId: number | null;
    companyId: string;
    slug: string;
    title: string;
    brand: string;
    imageUrl: string;
    /** Price of one `saleUnit` — per piece, or per kilogram when sold by weight. */
    price: number;
    oldPrice: number;
    packaging: string;
    /** What one unit of quantity is: "шт", or "кг" for weighted goods. */
    saleUnit: string;
    weighted: boolean;
    /** The least the store will sell, and the stepper's step, in `saleUnit`. */
    minQuantity: number;
    /** What Silpo prints on the shelf when that is not the sale-unit price; 0 when they agree. */
    shelfPrice: number;
    shelfOldPrice: number;
    /** The amount `shelfPrice` refers to: "100 г". */
    shelfUnit: string;
    inStock: boolean;
    hasPromo: boolean;
    promoLabel: string;
    url: string;
}

export interface ListItem {
    itemId: string;
    label: string;
    rawText: string;
    /** In the chosen product's sale unit — pieces, or kilograms when sold by weight. */
    quantity: number;
    unit: string;
    selectedProductId: string;
    candidates: ProductCandidate[];
    /** How many products the store has for this line; the strip shows a slice. */
    total: number;
}

/** How the full shelf for one line is ordered. */
export type ShelfSort = 'best' | 'cheap' | 'promo';

export interface ShelfPage {
    candidates: ProductCandidate[];
    total: number;
    offset: number;
    sort: ShelfSort;
}

export type StoreKind = 'delivery' | 'pickup';

export interface StoreInfo {
    branchId: string;
    deliveryType: string;
    kind: StoreKind;
    /** The address the guest thinks in: their own on delivery, the shop's on pickup. */
    shortLabel: string;
    storeLabel: string;
    /** The branch behind it — secondary, never the headline. */
    branchLabel: string;
    cartBranchId: string;
    cartDeliveryType: string;
    /** Human name of the branch the Silpo cart belongs to. */
    cartStoreLabel: string;
    matchesCart: boolean;
    orderMinimum: number | null;
    deliveryPrice: number | null;
    freeDeliveryFrom: number | null;
    deliveryTemporarilyUnavailable: boolean | null;
}

export interface StoreOption {
    branchId: string;
    deliveryType: string;
    kind: StoreKind;
    shortLabel: string;
    branchLabel: string;
    storeLabel: string;
}

export interface StoreOptions {
    addresses: StoreOption[];
    recent: StoreOption[];
    current: StoreOption | null;
    context: StoreInfo;
}

export interface CartInfo {
    /** Products in the cart — counted, so goods sold by weight cannot make it fractional. */
    itemCount: number;
    total: number;
    isEmpty: boolean;
}

export interface ListResponse {
    list: { listId: string; stage: string; storeLabel: string };
    store: StoreInfo;
    cart: CartInfo;
    items: ListItem[];
    totals: { total: number; productCount: number };
    basketUrl: string;
}

export interface HomeResponse {
    connected: boolean;
    activeList: { listId: string; stage: string; itemCount: number } | null;
    store: StoreInfo;
    cart: CartInfo;
    basketUrl: string;
}

/**
 * Picking a store re-prices the open list, so the answer is a whole list
 * payload. Opened from the home screen there is no list to re-price and only
 * the context comes back.
 */
export interface SelectStoreResponse extends Partial<ListResponse> {
    ok: boolean;
    store: StoreInfo;
}

export interface CheckoutResponse {
    ok: boolean;
    added: number;
    cartTotal: number;
    cartItemCount: number;
    basketUrl: string;
}

/** 409 body when the Silpo cart still belongs to a different store. */
export interface StoreMismatch {
    cartStoreLabel: string;
    storeLabel: string;
    cartItemCount: number;
    cartTotal: number;
}
