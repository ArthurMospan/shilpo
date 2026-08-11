export interface ProductCandidate {
    productId: string;
    externalProductId: number | null;
    companyId: string;
    slug: string;
    title: string;
    brand: string;
    imageUrl: string;
    price: number;
    oldPrice: number;
    packaging: string;
    priceUnit: string;
    inStock: boolean;
    hasPromo: boolean;
    promoLabel: string;
    url: string;
}

export interface ListItem {
    itemId: string;
    label: string;
    rawText: string;
    quantity: number;
    unit: string;
    selectedProductId: string;
    candidates: ProductCandidate[];
}

export interface StoreInfo {
    storeLabel: string;
    city: string;
    address: string;
    deliveryType: string;
    orderMinimum: number | null;
    deliveryPrice: number | null;
    freeDeliveryFrom: number | null;
    deliveryTemporarilyUnavailable: boolean | null;
}

export interface CartInfo {
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

export interface CheckoutResponse {
    ok: boolean;
    added: number;
    cartTotal: number;
    cartItemCount: number;
    basketUrl: string;
}
