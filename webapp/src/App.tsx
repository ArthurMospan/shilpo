import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    ArrowRight, Check, ChevronDown, ChevronRight, Layers, ListPlus, Minus, Plus,
    RotateCcw, Search, ShoppingCart, Sparkles, Store, Trash2, Truck, X,
} from 'lucide-react';
import * as api from './api';
import { closeApp, haptic, initTelegram, openExternal } from './telegram';
import type {
    HomeResponse, ListItem, ListResponse, ProductCandidate,
    StoreInfo, StoreMismatch, StoreOption, StoreOptions,
} from './types';

const LOGO = '/shilpo.png';

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
    // Empty until the guest opens a specific list. The chat menu button carries
    // no list id, so that case lands on the home screen instead of an error.
    const [listId, setListId] = useState(listIdFromLocation);
    const [home, setHome] = useState<HomeResponse | null>(null);
    const [data, setData] = useState<ListResponse | null>(null);
    const [items, setItems] = useState<UiItem[]>([]);
    const [loadError, setLoadError] = useState<string>('');
    const [busy, setBusy] = useState(false);
    const [working, setWorking] = useState('');
    const [toast, setToast] = useState('');
    const [modeSheetOpen, setModeSheetOpen] = useState(false);
    const [mismatch, setMismatch] = useState<StoreMismatch | null>(null);
    const [storeSheetOpen, setStoreSheetOpen] = useState(false);
    const [alternativesFor, setAlternativesFor] = useState<UiItem | null>(null);
    const [done, setDone] = useState<{ added: number; total: number; basketUrl: string } | null>(null);
    const toastTimer = useRef<number | undefined>(undefined);

    const flash = useCallback((message: string) => {
        setToast(message);
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(''), 2400);
    }, []);

    useEffect(() => initTelegram(), []);

    const applyList = useCallback((response: ListResponse) => {
        setData(response);
        setItems(response.items.map(item => ({ ...item, dropped: false })));
    }, []);

    useEffect(() => {
        let cancelled = false;
        setLoadError('');
        const load = listId
            ? api.loadList(listId).then(response => { if (!cancelled) applyList(response); })
            : api.loadHome().then(response => { if (!cancelled) setHome(response); });
        load.catch((error: unknown) => {
            if (!cancelled) setLoadError(loadErrorKind(error));
        });
        return () => { cancelled = true; };
    }, [applyList, listId]);

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
        setMismatch(null);
        setBusy(true);
        try {
            const result = await api.checkout(listId, mode);
            haptic('success');
            setDone({ added: result.added, total: result.cartTotal, basketUrl: result.basketUrl });
        } catch (error) {
            haptic('error');
            if (error instanceof api.ApiError && error.code === 'store_mismatch') {
                setMismatch(error.details as unknown as StoreMismatch);
                return;
            }
            flash(error instanceof api.ApiError && error.status === 401
                ? 'Потрібно підключити Кабінет Сільпо'
                : 'Не вдалося оновити кошик Сільпо');
        } finally {
            setBusy(false);
        }
    }, [flash, listId]);

    const onPrimaryAction = useCallback(() => {
        if (!data || !totals.productCount) return;
        // An existing cart is the guest's, not ours to overwrite silently — and
        // a cart from another store cannot be added to at all.
        if (!data.cart.isEmpty) {
            if (!data.store.matchesCart) {
                setMismatch({
                    cartStoreLabel: data.store.cartStoreLabel,
                    storeLabel: data.store.storeLabel,
                    cartItemCount: data.cart.itemCount,
                    cartTotal: data.cart.total,
                });
            } else {
                setModeSheetOpen(true);
            }
            return;
        }
        void runCheckout('append');
    }, [data, runCheckout, totals.productCount]);

    /** Switching store re-prices everything, so the server hands back a fresh list. */
    const onPickStore = useCallback(async (store: StoreOption) => {
        setStoreSheetOpen(false);
        setWorking(listId ? 'Перешукую список у новому магазині…' : 'Змінюю магазин…');
        try {
            const response = await api.selectStore(store, listId);
            haptic('success');
            if (response.items) applyList(response as ListResponse);
            else if (home) setHome({ ...home, store: response.store });
        } catch {
            haptic('error');
            flash('Не вдалося змінити магазин');
        } finally {
            setWorking('');
        }
    }, [applyList, flash, home, listId]);

    const onNewList = useCallback(async () => {
        setWorking('Готую новий список…');
        try {
            await api.startNewList();
            haptic('success');
            closeApp();
        } catch {
            haptic('error');
            flash('Не вдалося почати новий список');
        } finally {
            setWorking('');
        }
    }, [flash]);

    if (loadError) return <ErrorScreen kind={loadError} />;

    // Opening a list from the home screen keeps the old `home` around for a
    // beat; rendering the list chrome before its data lands would crash.
    const store: StoreInfo | undefined = listId ? data?.store : home?.store;
    if (!store) return <LoadingScreen />;

    const header = <Header store={store} onPickStore={() => setStoreSheetOpen(true)} />;
    const overlays = (
        <>
            {storeSheetOpen && (
                <StoreSheet
                    current={store}
                    onClose={() => setStoreSheetOpen(false)}
                    onPick={onPickStore}
                />
            )}
            {working && <WorkingOverlay message={working} />}
            {toast && <div className="toast">{toast}</div>}
        </>
    );

    if (done) return <SuccessScreen result={done} store={store} />;

    if (!listId || !data) {
        return (
            <div className="shell">
                {header}
                <HomeScreen home={home!} onOpenList={setListId} onNewList={onNewList} />
                {overlays}
            </div>
        );
    }

    const belowMinimum = data.store.orderMinimum !== null && totals.total < data.store.orderMinimum;

    return (
        <div className="shell">
            {header}

            <main className="content">
                <div className="section-head">
                    <p className="section-kicker">Обери, що саме кладемо в кошик</p>
                    <span className="section-count">
                        {active.length} {pluralize(active.length, 'позиція', 'позиції', 'позицій')}
                    </span>
                </div>
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
                                    🚚 доставка <b>{money(data.store.deliveryPrice!)}</b>
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

            {mismatch && (
                <StoreMismatchSheet
                    mismatch={mismatch}
                    onReplace={() => void runCheckout('replace')}
                    onClose={() => setMismatch(null)}
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

            {overlays}
        </div>
    );
}

/** A 401 has two very different causes — never blame the Silpo account for a Telegram one. */
function loadErrorKind(error: unknown): string {
    if (!(error instanceof api.ApiError)) return 'failed';
    if (error.status === 404) return 'no-list';
    if (error.status !== 401) return 'failed';
    return error.code === 'telegram_identity' ? 'telegram' : 'not-connected';
}

// ── Chrome ──────────────────────────────────────────────────────────

function Header({ store, onPickStore }: { store: StoreInfo; onPickStore(): void }) {
    return (
        <header className="header">
            <img className="brand-logo" src={LOGO} alt="Шільпо" />
            <button className="store-chip" onClick={onPickStore}>
                {store.kind === 'pickup' ? <Store size={13} /> : <Truck size={13} />}
                <span>{store.shortLabel}</span>
                <ChevronDown size={13} />
            </button>
        </header>
    );
}

function HomeScreen({ home, onOpenList, onNewList }: {
    home: HomeResponse;
    onOpenList(listId: string): void;
    onNewList(): void;
}) {
    return (
        <main className="content home">
            {home.activeList?.stage === 'picking' ? (
                <button className="home-card accent" onClick={() => onOpenList(home.activeList!.listId)}>
                    <span className="home-card-icon"><ShoppingCart size={20} /></span>
                    <span className="home-card-copy">
                        <small>Список у роботі</small>
                        <strong>
                            Продовжити вибір · {home.activeList.itemCount}{' '}
                            {pluralize(home.activeList.itemCount, 'позиція', 'позиції', 'позицій')}
                        </strong>
                    </span>
                    <ArrowRight size={18} />
                </button>
            ) : home.activeList ? (
                // Still being clarified or searched — there is nothing to pick yet,
                // and the answer the bot is waiting for lives in the chat.
                <button className="home-card" onClick={closeApp}>
                    <span className="home-card-icon soft"><Sparkles size={20} /></span>
                    <span className="home-card-copy">
                        <small>Список у роботі</small>
                        <strong>Чекаю на відповідь у чаті</strong>
                        <em>Щойно розберуся зі списком — покажу товари тут</em>
                    </span>
                    <ArrowRight size={18} />
                </button>
            ) : (
                <div className="home-empty">
                    <span className="emoji">📝</span>
                    <strong>Списку в роботі немає</strong>
                    <p>Надішли боту фото свого списку покупок — хоч рукописного — або напиши товари текстом.</p>
                </div>
            )}

            <button
                className="home-card"
                onClick={() => openExternal(home.basketUrl)}
            >
                <span className="home-card-icon soft"><Store size={20} /></span>
                <span className="home-card-copy">
                    <small>Кошик Сільпо</small>
                    <strong>
                        {home.cart.isEmpty
                            ? 'Порожній'
                            : `${home.cart.itemCount} ${pluralize(home.cart.itemCount, 'товар', 'товари', 'товарів')} · ${money(home.cart.total)}`}
                    </strong>
                    <em>{home.store.storeLabel}</em>
                </span>
                <ArrowRight size={18} />
            </button>

            <button className="primary-button home-action" onClick={onNewList}>
                <ListPlus size={19} /> Новий список
            </button>
            <p className="home-hint">
                Кнопка звільнить місце для нового списку й підкаже в чаті, що надіслати.
            </p>
        </main>
    );
}

// ── List ────────────────────────────────────────────────────────────

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
                        <Layers size={14} /> Шукати серед усіх товарів
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

// ── Sheets ──────────────────────────────────────────────────────────

function Sheet({ title, onClose, children }: {
    title: string;
    onClose(): void;
    children: ReactNode;
}) {
    return (
        <div className="backdrop" onClick={onClose}>
            <div className="sheet" onClick={event => event.stopPropagation()}>
                <div className="sheet-head">
                    <h2>{title}</h2>
                    <button className="item-remove" onClick={onClose} aria-label="Закрити"><X size={16} /></button>
                </div>
                {children}
            </div>
        </div>
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
        <Sheet title="У кошику вже є товари" onClose={onClose}>
            <p className="sheet-text">
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
        </Sheet>
    );
}

function StoreMismatchSheet({ mismatch, onReplace, onClose }: {
    mismatch: StoreMismatch;
    onReplace(): void;
    onClose(): void;
}) {
    return (
        <Sheet title="Кошик — з іншого магазину" onClose={onClose}>
            <p className="sheet-text">
                У кошику Сільпо вже <b>{mismatch.cartItemCount} {pluralize(mismatch.cartItemCount, 'товар', 'товари', 'товарів')}</b>
                {' '}на {money(mismatch.cartTotal)} — і він належить {mismatch.cartStoreLabel
                    ? <>магазину <b>{mismatch.cartStoreLabel}</b></>
                    : <b>іншому магазину</b>}.
                {' '}Один кошик Сільпо живе в одному магазині, тож товари за цінами «{mismatch.storeLabel}»
                можна покласти лише в порожній кошик.
            </p>
            <div className="sheet-actions">
                <button className="sheet-option danger" onClick={onReplace}>
                    <i><RotateCcw size={18} /></i>
                    <span>
                        <strong>Очистити й покласти</strong>
                        <small>Старі товари зникнуть, у кошику буде лише цей список</small>
                    </span>
                </button>
            </div>
            <button className="sheet-cancel" onClick={onClose}>Залишити як є</button>
        </Sheet>
    );
}

/**
 * Where the guest shops. On delivery that is *their* address — the branch
 * behind it is Silpo's business, so it stays a small grey line.
 */
function StoreSheet({ current, onClose, onPick }: {
    current: StoreInfo;
    onClose(): void;
    onPick(store: StoreOption): Promise<void>;
}) {
    const [options, setOptions] = useState<StoreOptions | null>(null);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<StoreOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        api.loadStoreOptions()
            .then(response => { if (!cancelled) setOptions(response); })
            .catch(() => { if (!cancelled) setFailed(true); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        const trimmed = query.trim();
        if (trimmed.length < 2) {
            setResults([]);
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => {
            api.searchStores(trimmed)
                .then(response => { if (!cancelled) setResults(response.stores); })
                .catch(() => { if (!cancelled) setResults([]); });
        }, 280);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [query]);

    const isCurrent = (store: StoreOption): boolean =>
        store.branchId === current.branchId
        && store.deliveryType.toLowerCase() === current.deliveryType.toLowerCase();

    const searching = query.trim().length >= 2;

    return (
        <Sheet title="Звідки беремо ціни" onClose={onClose}>
            <p className="sheet-text">
                Ціни, наявність і акції — саме цього магазину. Кошик Сільпо живе в одному магазині:
                якщо обереш інший, перед додаванням доведеться його очистити.
            </p>

            <div className="search-input">
                <Search size={17} color="#8d8d85" />
                <input
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder="Місто або вулиця магазину"
                    autoComplete="off"
                />
                {query && (
                    <button className="item-remove" onClick={() => setQuery('')} aria-label="Очистити">
                        <X size={15} />
                    </button>
                )}
            </div>

            <div className="store-scroll">
                {loading && <div className="store-loading"><span className="spinner" /> Завантажую магазини…</div>}
                {failed && !loading && <p className="sheet-error">Не вдалося отримати список магазинів.</p>}

                {searching ? (
                    <StoreGroup
                        title="Самовивіз — знайдені магазини"
                        stores={results}
                        isCurrent={isCurrent}
                        onPick={onPick}
                        empty="Нічого не знайшлося за цим запитом"
                    />
                ) : options ? (
                    <>
                        <StoreGroup
                            title="Доставка на мою адресу"
                            stores={options.addresses}
                            isCurrent={isCurrent}
                            onPick={onPick}
                            empty="У Кабінеті Сільпо ще немає збережених адрес"
                        />
                        <StoreGroup
                            title="Самовивіз — куди вже заїжджав"
                            stores={options.recent}
                            isCurrent={isCurrent}
                            onPick={onPick}
                            empty="Історії самовивозу ще немає — знайди магазин пошуком"
                        />
                        {options.current && !options.addresses.some(isCurrent) && !options.recent.some(isCurrent) && (
                            <StoreGroup
                                title="Зараз обрано"
                                stores={[options.current]}
                                isCurrent={isCurrent}
                                onPick={onPick}
                            />
                        )}
                    </>
                ) : null}
            </div>
        </Sheet>
    );
}

function StoreGroup({ title, stores, isCurrent, onPick, empty }: {
    title: string;
    stores: StoreOption[];
    isCurrent(store: StoreOption): boolean;
    onPick(store: StoreOption): Promise<void>;
    empty?: string;
}) {
    return (
        <div className="store-group">
            <p>{title}</p>
            {stores.length ? stores.map(store => (
                <button
                    key={`${store.branchId}-${store.deliveryType}`}
                    className={`store-option${isCurrent(store) ? ' current' : ''}`}
                    onClick={() => void onPick(store)}
                >
                    <i>{store.kind === 'pickup' ? <Store size={17} /> : <Truck size={17} />}</i>
                    <span>
                        <strong>{store.shortLabel}</strong>
                        <small>{store.branchLabel}</small>
                    </span>
                    {isCurrent(store) ? <Check size={17} color="#16845b" /> : <ChevronRight size={17} color="#b6b6ae" />}
                </button>
            )) : empty ? <span className="store-empty">{empty}</span> : null}
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
        <Sheet title="Усі варіанти" onClose={onClose}>
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
                    {searching
                        ? <span className="spinner" style={{ width: 15, height: 15, borderWidth: 2 }} />
                        : <ArrowRight size={15} />}
                </button>
            </div>

            {error && <p className="sheet-error">{error}</p>}

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
        </Sheet>
    );
}

// ── Full-screen states ──────────────────────────────────────────────

function LoadingScreen() {
    return (
        <div className="state-screen splash">
            <img className="splash-logo" src={LOGO} alt="Шільпо" />
            <span className="spinner" />
            <p>Готую твій список…</p>
        </div>
    );
}

function WorkingOverlay({ message }: { message: string }) {
    return (
        <div className="working">
            <img className="splash-logo small" src={LOGO} alt="" />
            <span className="spinner" />
            <p>{message}</p>
        </div>
    );
}

function ErrorScreen({ kind }: { kind: string }) {
    const content = kind === 'not-connected'
        ? { emoji: '🔐', title: 'Кабінет Сільпо не підключено', text: 'Повернись у чат і натисни «Підключити Кабінет Сільпо».' }
        : kind === 'telegram'
            ? { emoji: '🔄', title: 'Telegram не підтвердив вхід', text: 'Закрий це вікно й відкрий список кнопкою в чаті ще раз. Якщо не допомогло — онови Telegram до останньої версії.' }
            : kind === 'no-list'
                ? { emoji: '📝', title: 'Списку немає', text: 'Надішли боту фото свого списку покупок або напиши товари текстом — і я підберу їх у Сільпо.' }
                : { emoji: '😞', title: 'Щось пішло не так', text: 'Спробуй відкрити список ще раз за хвилину.' };

    return (
        <div className="state-screen">
            <span className="emoji">{content.emoji}</span>
            <h2>{content.title}</h2>
            <p>{content.text}</p>
            <button className="ghost-button" onClick={closeApp}>Закрити</button>
        </div>
    );
}

function SuccessScreen({ result, store }: {
    result: { added: number; total: number; basketUrl: string };
    store: StoreInfo;
}) {
    return (
        <div className="shell">
            <header className="header">
                <img className="brand-logo" src={LOGO} alt="Шільпо" />
                <span className="store-chip static">Готово</span>
            </header>
            <main className="content" style={{ paddingTop: 22 }}>
                <div className="success-card">
                    <span className="emoji">🛒</span>
                    <strong>Кошик наповнено</strong>
                    <p>
                        {result.added} {pluralize(result.added, 'позиція', 'позиції', 'позицій')} у кошику Сільпо
                        <br />на суму <b>{money(result.total)}</b>
                        <br /><br />{store.storeLabel}
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
