import { telegram } from './telegram';
import type { CheckoutResponse, ListResponse, ProductCandidate } from './types';

export class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly code = '') {
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
            String(body?.code || '')
        );
    }
    return response.json() as Promise<T>;
}

export function loadList(listId: string): Promise<ListResponse> {
    return request<ListResponse>(`/api/list/${encodeURIComponent(listId)}`);
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
