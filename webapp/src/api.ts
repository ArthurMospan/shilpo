import { telegram } from './telegram';
import type {
    CheckoutResponse,
    HomeResponse,
    ListResponse,
    ProductCandidate,
    SelectStoreResponse,
    StoreOption,
    StoreOptions,
} from './types';

export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code = '',
        /** The rest of the error body — a 409 carries which stores clash. */
        readonly details: Record<string, unknown> = {}
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            // Telegram signs this payload with the bot token; the server
            // verifies it and derives the user id from it.
            'X-Telegram-Init-Data': telegram()?.initData ?? '',
            ...(options.headers || {}),
        },
    });
    if (!response.ok) {
        const body: any = await response.json().catch(() => ({}));
        throw new ApiError(
            String(body?.error || `HTTP ${response.status}`),
            response.status,
            String(body?.code || ''),
            body && typeof body === 'object' ? body : {}
        );
    }
    return response.json() as Promise<T>;
}

export function loadList(listId: string): Promise<ListResponse> {
    return request<ListResponse>(`/api/list/${encodeURIComponent(listId)}`);
}

export function loadHome(): Promise<HomeResponse> {
    return request<HomeResponse>('/api/home');
}

export function startNewList(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/new-list', { method: 'POST' });
}

interface Totals { total: number; productCount: number }

export function selectProduct(listId: string, itemId: string, productId: string): Promise<Totals> {
    return request<Totals>(`/api/list/${encodeURIComponent(listId)}/select`, {
        method: 'POST',
        body: JSON.stringify({ itemId, productId }),
    });
}

export function setQuantity(listId: string, itemId: string, quantity: number): Promise<Totals> {
    return request<Totals>(`/api/list/${encodeURIComponent(listId)}/quantity`, {
        method: 'POST',
        body: JSON.stringify({ itemId, quantity }),
    });
}

export function setDropped(listId: string, itemId: string, dropped: boolean): Promise<Totals> {
    return request<Totals>(`/api/list/${encodeURIComponent(listId)}/remove`, {
        method: 'POST',
        body: JSON.stringify({ itemId, dropped }),
    });
}

export function searchAlternatives(
    listId: string,
    itemId: string,
    query: string
): Promise<{ candidates: ProductCandidate[] }> {
    return request<{ candidates: ProductCandidate[] }>(`/api/list/${encodeURIComponent(listId)}/search`, {
        method: 'POST',
        body: JSON.stringify({ itemId, query }),
    });
}

export function checkout(listId: string, mode: 'append' | 'replace'): Promise<CheckoutResponse> {
    return request<CheckoutResponse>(`/api/list/${encodeURIComponent(listId)}/checkout`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
    });
}

export function loadStoreOptions(): Promise<StoreOptions> {
    return request<StoreOptions>('/api/stores/options');
}

export function searchStores(query: string): Promise<{ stores: StoreOption[] }> {
    return request<{ stores: StoreOption[] }>(`/api/stores/search?q=${encodeURIComponent(query)}`);
}

/**
 * Switching store re-prices the whole list, so the server answers with the
 * full list payload rather than an acknowledgement.
 */
export function selectStore(store: StoreOption, listId: string): Promise<SelectStoreResponse> {
    return request<SelectStoreResponse>('/api/stores/select', {
        method: 'POST',
        body: JSON.stringify({
            branchId: store.branchId,
            deliveryType: store.deliveryType,
            label: store.shortLabel,
            listId,
        }),
    });
}
