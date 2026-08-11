import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Check, ChevronDown, Layers, MapPin, Minus, Plus, RotateCcw,
    Search, ShoppingCart, Sparkles, Trash2, Truck, X,
} from 'lucide-react';
import * as api from './api';
import { haptic, initTelegram, openExternal } from './telegram';
import type { ListItem, ListResponse, ProductCandidate } from './types';

const money = (value: number): string => `${value.toFixed(2).replace('.', ',')} ₴`;

function pluralize(count: number, one: string, few: string, many: string): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

function listIdFromLocation(): string {
    const fromQuery = new URLSearchParams(window.location.search).get('list');
    if (fromQuery) return fromQuery;
    // Telegram passes `startapp` payloads through the hash on some clients.
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    return hash.get('list') || hash.get('tgWebAppStartParam') || '';
}

interface UiItem extends ListItem {
    dropped: boolean;
}

export default function App() {
    const [listId] = useState(listIdFromLocation);
    const [data, setData] = useState<ListResponse | null>(null);
    const [items, setItems] = useState<UiItem[]>([]);
    const [loadError, setLoadError] = useState<string>('');
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState('');
    const [modeSheetOpen, setModeSheetOpen] = useState(false);
    const [alternativesFor, setAlternativesFor] = useState<UiItem | null>(null);
    const [done, setDone] = useState<{ added: number; total: number; basketUrl: string } | null>(null);
    const toastTimer = useRef<number | undefined>(undefined);

    const flash = useCallback((message: string) => {
        setToast(message);
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(''), 2400);
    }, []);

    useEffect(() => {
        initTelegram();
    }, []);

    useEffect(() => {
        if (!listId) {
            setLoadError('no-list');
            return;
        }
        let cancelled = false;
        api.loadList(listId)
            .then((response) => {
                if (cancelled) return;
                setData(response);
                setItems(response.items.map(item => ({ ...item, dropped: false })));
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                const status = error instanceof api.ApiError ? error.status : 0;
                setLoadError(status === 401 ? 'not-connected' : status === 404 ? 'no-list' : 'failed');
            });
        return () => { cancelled = true; };
    }, [listId]);

    const active = useMemo(() => items.filter(item => !item.dropped), [items]);

    const totals = useMemo(() => {
        let total = 0;
        let productCount = 0;
        let missing = 0;
        for (const item of active) {
            const product = item.candidates.find(candidate => candidate.productId === item.selectedProductId);
            if (!product) {
                missing += 1;
                continue;
            }
            total += product.price * item.quantity;
            productCount += item.quantity;
        }
        return { total, productCount, missing };
    }, [active]);

    const patchItem = useCallback((itemId: string, patch: Partial<UiItem>) => {
        setItems(current => current.map(item => (item.itemId === itemId ? { ...item, ...patch } : item)));
    }, []);

    const onSelect = useCallback((item: UiItem, product: ProductCandidate) => {
        if (item.selectedProductId === product.productId) return;
        haptic('select');
        patchItem(item.itemId, { selectedProductId: product.productId });
        api.selectProduct(listId, item.itemId, product.productId).catch(() => flash('Не вдалося зберегти вибір'));
    }, [flash, listId, patchItem]);

    const onQuantity = useCallback((item: UiItem, quantity: number) => {
        const next = Math.max(1, Math.min(99, quantity));
        if (next === item.quantity) return;
        haptic('tap');
        patchItem(item.itemId, { quantity: next });
        api.setQuantity(listId, item.itemId, next).catch(() => flash('Не вдалося змінити кількість'));
    }, [flash, listId, patchItem]);

    const onToggleDropped = useCallback((item: UiItem) => {
        const dropped = !item.dropped;
        haptic('tap');
        patchItem(item.itemId, { dropped });
        api.setDropped(listId, item.itemId, dropped).catch(() => flash('Не вдалося оновити список'));
    }, [flash, listId, patchItem]);

    const runCheckout = useCallback(async (mode: 'append' | 'replace') => {
        setModeSheetOpen(false);
        setBusy(true);
        try {
            const result = await api.checkout(listId, mode);
            haptic('success');
            setDone({ added: result.added, total: result.cartTotal, basketUrl: result.basketUrl });
        } catch (error) {
            haptic('error');
            flash(error instanceof api.ApiError && error.status === 401
                ? 'Потрібно підключити Кабінет Сільпо'
                : 'Не вдалося оновити кошик Сільпо');
        } finally {
            setBusy(false);
        }
    }, [flash, listId]);

    const onPrimaryAction = useCallback(() => {
        if (!data || !totals.productCount) return;
        // An existing cart is the guest's, not ours to overwrite silently.
        if (!data.cart.isEmpty) {
            setModeSheetOpen(true);
            return;
        }
        void runCheckout('append');
    }, [data, runCheckout, totals.productCount]);

    if (loadError) return <ErrorScreen kind={loadError} />;
    if (!data) return <LoadingScreen />;
    if (done) return <SuccessScreen result={done} storeLabel={data.store.storeLabel} />;

    const belowMinimum = data.store.orderMinimum !== null && totals.total < data.store.orderMinimum;

    return (
        <div className="shell">
            <header className="header">
                <div className="brand">
                    <span className="brand-mark">🍊</span>
                    <div>
                        <small>СПИСКИ ШІЛЬПО</small>
                        <h1>Мій список</h1>
                    </div>
                </div>
                <span className="store-chip">{active.length} {pluralize(active.length, 'позиція', 'позиції', 'позицій')}</span>
            </header>

            <div className="store-bar">
                <MapPin size={18} />
                <div className="store-bar-copy">
                    <small>Магазин і ціни</small>
                    <strong>{data.store.storeLabel}</strong>
                </div>
                <span className="store-chip">{deliveryLabel(data.store.deliveryType)}</span>
            </div>

            <main className="content">
                <p className="section-kicker">Обери, що саме кладемо в кошик</p>
                <div className="items">
                    {items.map(item => (
                        <ItemCard
                            key={item.itemId}
                            item={item}
                            onSelect={onSelect}
                            onQuantity={onQuantity}
                            onToggleDropped={onToggleDropped}
                            onOpenAlternatives={() => setAlternativesFor(item)}
                        />
                    ))}
                </div>
            </main>

            <footer className="footer">
                <div className="footer-inner">
                    <div className="footer-summary">
                        <div className="footer-total">
                            <small>Разом</small>
                            <strong>{money(totals.total)}</strong>
                        </div>
                        <div className="footer-delivery">
                            <div>
                                <b>{totals.productCount}</b> {pluralize(totals.productCount, 'товар', 'товари', 'товарів')}
                                {totals.missing > 0 && <> · {totals.missing} без вибору</>}
                            </div>
                            {data.store.deliveryPrice !== null && (
                                <div>
                                    🚚 доставка <b>{money(data.store.deliveryPrice)}</b>
                                    {data.store.freeDeliveryFrom ? ` · безкоштовно від ${money(data.store.freeDeliveryFrom)}` : ''}
                                </div>
                            )}
                            {belowMinimum && (
                                <div className="footer-warning">
                                    До мінімального замовлення ще {money(data.store.orderMinimum! - totals.total)}
                                </div>
                            )}
                            {!data.cart.isEmpty && (
                                <div>У кошику вже <b>{data.cart.itemCount}</b> · {money(data.cart.total)}</div>
                            )}
                        </div>
                    </div>
                    <button
                        className="primary-button"
                        onClick={onPrimaryAction}
                        disabled={busy || totals.productCount === 0}
                    >
                        {busy
                            ? <><span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /> Додаю…</>
                            : <><ShoppingCart size={19} /> Додати в кошик · {money(totals.total)}</>}
                    </button>
                </div>
            </footer>

            {modeSheetOpen && (
                <CartModeSheet
                    cartCount={data.cart.itemCount}
                    cartTotal={data.cart.total}
                    addingCount={totals.productCount}
                    onAppend={() => void runCheckout('append')}
                    onReplace={() => void runCheckout('replace')}
                    onClose={() => setModeSheetOpen(false)}
                />
            )}

            {alternativesFor && (
                <AlternativesSheet
                    listId={listId}
                    item={alternativesFor}
                    onClose={() => setAlternativesFor(null)}
                    onPicked={(candidates, product) => {
                        patchItem(alternativesFor.itemId, { candidates, selectedProductId: product.productId });
                        setAlternativesFor(null);
                        haptic('select');
                    }}
                />
            )}

            {toast && <div className="toast">{toast}</div>}
        </div>
    );
}

function deliveryLabel(deliveryType: string): string {
    if (/pickup/i.test(deliveryType)) return 'Самовивіз';
    if (/novaposhta/i.test(deliveryType)) return 'Нова пошта';
    if (/wide/i.test(deliveryType)) return 'Широкий асортимент';
    return 'Доставка';
}

interface ItemCardProps {
    item: UiItem;
    onSelect(item: UiItem, product: ProductCandidate): void;
    onQuantity(item: UiItem, quantity: number): void;
    onToggleDropped(item: UiItem): void;
    onOpenAlternatives(): void;
}

function ItemCard({ item, onSelect, onQuantity, onToggleDropped, onOpenAlternatives }: ItemCardProps) {
    const selected = item.candidates.find(candidate => candidate.productId === item.selectedProductId) || null;
    const lineTotal = selected ? selected.price * item.quantity : 0;

    return (
        <section className={`item-card${item.dropped ? ' dropped' : ''}`}>
            <div className="item-head">
                <div className="item-title">
                    <strong>{item.label}</strong>
                    {item.rawText && item.rawText.toLowerCase() !== item.label.toLowerCase() && (
                        <small>у списку: «{item.rawText}»</small>
                    )}
                </div>
                <button
                    className={`item-remove${item.dropped ? ' restore' : ''}`}
                    onClick={() => onToggleDropped(item)}
                    aria-label={item.dropped ? 'Повернути позицію' : 'Прибрати позицію'}
                >
                    {item.dropped ? <RotateCcw size={15} /> : <Trash2 size={15} />}
                </button>
            </div>

            {item.candidates.length === 0 ? (
                <>
                    <div className="item-missing">
                        <Sparkles size={15} />
                        <span>Не знайшла цей товар у твоєму магазині. Спробуй пошукати іншими словами.</span>
                    </div>
                    <button className="more-button" onClick={onOpenAlternatives}>
                        <Search size={14} /> Пошукати вручну
                    </button>
                </>
            ) : (
                <>
                    <div className="candidate-strip">
                        {item.candidates.map(candidate => (
                            <CandidateCard
                                key={candidate.productId}
                                candidate={candidate}
                                selected={candidate.productId === item.selectedProductId}
                                onSelect={() => onSelect(item, candidate)}
                            />
                        ))}
                    </div>

                    <div className="item-footer">
                        <div className="stepper">
                            <button onClick={() => onQuantity(item, item.quantity - 1)} disabled={item.quantity <= 1} aria-label="Менше">
                                <Minus size={15} />
                            </button>
                            <span>{item.quantity} {item.unit || 'шт'}</span>
                            <button onClick={() => onQuantity(item, item.quantity + 1)} disabled={item.quantity >= 99} aria-label="Більше">
                                <Plus size={15} />
                            </button>
                        </div>
                        <div className="line-total">
                            {money(lineTotal)}
                            {selected && item.quantity > 1 && <small>{money(selected.price)} × {item.quantity}</small>}
                        </div>
                    </div>

                    <button className="more-button" onClick={onOpenAlternatives}>
                        <Layers size={14} /> Інші варіанти
                    </button>
                </>
            )}
        </section>
    );
}

function CandidateCard({ candidate, selected, onSelect }: {
    candidate: ProductCandidate;
    selected: boolean;
    onSelect(): void;
}) {
    const discount = candidate.oldPrice > candidate.price
        ? Math.round((1 - candidate.price / candidate.oldPrice) * 100)
        : 0;

    return (
        <button
            className={`candidate${selected ? ' selected' : ''}${candidate.inStock ? '' : ' out-of-stock'}`}
            onClick={onSelect}
        >
            {discount > 0 && <span className="candidate-flag">−{discount}%</span>}
            {selected && <span className="candidate-check"><Check size={12} strokeWidth={3.5} /></span>}
            <span className="candidate-media">
                {candidate.imageUrl
                    ? <img src={candidate.imageUrl} alt="" loading="lazy" />
                    : <span className="fallback">🛍️</span>}
            </span>
            <span className="candidate-price">
                <b>{money(candidate.price)}</b>
                {discount > 0 && <del>{money(candidate.oldPrice)}</del>}
            </span>
            <span className="candidate-name">{candidate.title}</span>
            {candidate.packaging && <span className="candidate-pack">{candidate.packaging}</span>}
        </button>
    );
}

function CartModeSheet({ cartCount, cartTotal, addingCount, onAppend, onReplace, onClose }: {
    cartCount: number;
    cartTotal: number;
    addingCount: number;
    onAppend(): void;
    onReplace(): void;
    onClose(): void;
}) {
    return (
        <div className="backdrop" onClick={onClose}>
            <div className="sheet" onClick={event => event.stopPropagation()}>
                <h2>У кошику вже є товари</h2>
                <p>
                    Зараз у кошику Сільпо <b>{cartCount} {pluralize(cartCount, 'товар', 'товари', 'товарів')}</b> на {money(cartTotal)}.
                    Що зробити з {addingCount} {pluralize(addingCount, 'товаром', 'товарами', 'товарами')} зі списку?
                </p>
                <div className="sheet-actions">
                    <button className="sheet-option" onClick={onAppend}>
                        <i><Plus size={18} /></i>
                        <span>
                            <strong>Додати до наявних</strong>
                            <small>Старі товари залишаться в кошику</small>
                        </span>
                    </button>
                    <button className="sheet-option danger" onClick={onReplace}>
                        <i><RotateCcw size={18} /></i>
                        <span>
                            <strong>Замінити кошик</strong>
                            <small>Очищу кошик і покладу лише товари зі списку</small>
                        </span>
                    </button>
                </div>
                <button className="sheet-cancel" onClick={onClose}>Скасувати</button>
            </div>
        </div>
    );
}

function AlternativesSheet({ listId, item, onClose, onPicked }: {
    listId: string;
    item: UiItem;
    onClose(): void;
    onPicked(candidates: ProductCandidate[], product: ProductCandidate): void;
}) {
    const [query, setQuery] = useState(item.label);
    const [results, setResults] = useState<ProductCandidate[]>(item.candidates);
    const [searching, setSearching] = useState(false);
    const [error, setError] = useState('');

    const runSearch = useCallback(async () => {
        const trimmed = query.trim();
        if (trimmed.length < 2) return;
        setSearching(true);
        setError('');
        try {
            const response = await api.searchAlternatives(listId, item.itemId, trimmed);
            setResults(response.candidates);
            if (!response.candidates.length) setError('Нічого не знайшлося. Спробуй інші слова.');
        } catch {
            setError('Пошук не вдався. Спробуй ще раз.');
        } finally {
            setSearching(false);
        }
    }, [item.itemId, listId, query]);

    return (
        <div className="backdrop" onClick={onClose}>
            <div className="sheet" onClick={event => event.stopPropagation()}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <h2 style={{ margin: 0 }}>Інші варіанти</h2>
                    <button className="item-remove" onClick={onClose} aria-label="Закрити"><X size={16} /></button>
                </div>

                <div className="search-input">
                    <Search size={17} color="#8d8d85" />
                    <input
                        value={query}
                        onChange={event => setQuery(event.target.value)}
                        onKeyDown={event => { if (event.key === 'Enter') void runSearch(); }}
                        placeholder="Що шукаємо?"
                        autoComplete="off"
                    />
                    <button className="item-remove" onClick={() => void runSearch()} disabled={searching} aria-label="Шукати">
                        {searching ? <span className="spinner" style={{ width: 15, height: 15, borderWidth: 2 }} /> : <ChevronDown size={15} style={{ transform: 'rotate(-90deg)' }} />}
                    </button>
                </div>

                {error && <p style={{ margin: '0 0 12px', color: '#c4432b', fontSize: 12 }}>{error}</p>}

                <div className="search-results">
                    {results.map(candidate => (
                        <button key={candidate.productId} className="search-result" onClick={() => onPicked(results, candidate)}>
                            <span className="search-result-media">
                                {candidate.imageUrl ? <img src={candidate.imageUrl} alt="" loading="lazy" /> : '🛍️'}
                            </span>
                            <span className="search-result-copy">
                                <strong>{candidate.title}</strong>
                                {candidate.packaging && <span>{candidate.packaging}</span>}
                                <b>{money(candidate.price)}</b>
                            </span>
                            {candidate.productId === item.selectedProductId && <Check size={17} color="#16845b" />}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

function LoadingScreen() {
    return (
        <div className="state-screen">
            <span className="spinner" />
            <p>Готую твій список…</p>
        </div>
    );
}

function ErrorScreen({ kind }: { kind: string }) {
    const content = kind === 'not-connected'
        ? { emoji: '🔐', title: 'Кабінет Сільпо не підключено', text: 'Повернись у чат і натисни «Підключити Кабінет Сільпо».' }
        : kind === 'no-list'
            ? { emoji: '📝', title: 'Списку немає', text: 'Надішли боту фото свого списку покупок або напиши товари текстом — і я підберу їх у Сільпо.' }
            : { emoji: '😞', title: 'Щось пішло не так', text: 'Спробуй відкрити список ще раз за хвилину.' };

    return (
        <div className="state-screen">
            <span className="emoji">{content.emoji}</span>
            <h2>{content.title}</h2>
            <p>{content.text}</p>
        </div>
    );
}

function SuccessScreen({ result, storeLabel }: {
    result: { added: number; total: number; basketUrl: string };
    storeLabel: string;
}) {
    return (
        <div className="shell">
            <header className="header">
                <div className="brand">
                    <span className="brand-mark">🍊</span>
                    <div>
                        <small>СПИСКИ ШІЛЬПО</small>
                        <h1>Готово!</h1>
                    </div>
                </div>
            </header>
            <main className="content" style={{ paddingTop: 22 }}>
                <div className="success-card">
                    <span className="emoji">🛒</span>
                    <strong>Кошик наповнено</strong>
                    <p>
                        {result.added} {pluralize(result.added, 'позиція', 'позиції', 'позицій')} у кошику Сільпо
                        <br />на суму <b>{money(result.total)}</b>
                        <br /><br />{storeLabel}
                    </p>
                </div>
                <button
                    className="primary-button"
                    style={{ marginTop: 18 }}
                    onClick={() => openExternal(result.basketUrl)}
                >
                    <Truck size={19} /> Перейти до оформлення
                </button>
            </main>
        </div>
    );
}
