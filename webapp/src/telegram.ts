interface TelegramWebApp {
    initData: string;
    initDataUnsafe?: { user?: { id?: number; first_name?: string } };
    isFullscreen?: boolean;
    safeAreaInset?: { top?: number; bottom?: number; left?: number; right?: number };
    contentSafeAreaInset?: { top?: number; bottom?: number; left?: number; right?: number };
    ready(): void;
    expand(): void;
    close(): void;
    openLink(url: string, options?: { try_instant_view?: boolean }): void;
    setHeaderColor?(color: string): void;
    setBackgroundColor?(color: string): void;
    setBottomBarColor?(color: string): void;
    /** Bot API 7.7 — stops the swipe-down-to-minimise gesture. */
    disableVerticalSwipes?(): void;
    /** Bot API 8.0 — takes over the whole screen, Telegram's chrome floating on top. */
    requestFullscreen?(): void;
    exitFullscreen?(): void;
    onEvent?(event: string, handler: () => void): void;
    offEvent?(event: string, handler: () => void): void;
    HapticFeedback?: {
        impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
        notificationOccurred(type: 'error' | 'success' | 'warning'): void;
        selectionChanged(): void;
    };
    BackButton?: { show(): void; hide(): void; onClick(handler: () => void): void; offClick(handler: () => void): void };
}

declare global {
    interface Window {
        Telegram?: { WebApp?: TelegramWebApp };
    }
}

export function telegram(): TelegramWebApp | undefined {
    return window.Telegram?.WebApp;
}

// In fullscreen Telegram draws its Close and More controls *over* the page,
// near the top right. Some clients report the inset a few frames late, so a
// floor is reserved until the real number arrives — a header sliding out from
// under the close button looks far worse than one that never moved.
const FULLSCREEN_TOP_FLOOR = 76;

const INSET_EVENTS = ['safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged', 'viewportChanged'];

function syncInsets(): void {
    const app = telegram();
    const root = document.documentElement;
    const top = Math.max(
        Number(app?.safeAreaInset?.top || 0),
        Number(app?.contentSafeAreaInset?.top || 0),
        app?.isFullscreen ? FULLSCREEN_TOP_FLOOR : 0
    );
    const bottom = Math.max(
        Number(app?.safeAreaInset?.bottom || 0),
        Number(app?.contentSafeAreaInset?.bottom || 0)
    );
    root.style.setProperty('--tg-runtime-safe-top', `${top}px`);
    root.style.setProperty('--tg-runtime-safe-bottom', `${bottom}px`);
}

/**
 * Puts the Mini App in the state it is designed for: the whole screen, and no
 * vertical swipe that would drag it away mid-choice. Returns a teardown so
 * React can unsubscribe the inset listeners.
 */
export function initTelegram(): () => void {
    const app = telegram();
    if (!app) {
        syncInsets();
        return () => undefined;
    }

    // An older client throws WebAppMethodUnsupported rather than ignoring a
    // method it does not know, and one missing feature must not take the whole
    // app down with it.
    const attempt = (action: () => void): void => {
        try {
            action();
        } catch {
            // Older Telegram — the app degrades to a normal expanded Mini App.
        }
    };

    attempt(() => app.ready());
    attempt(() => app.expand());
    // A guest scrolling a strip of products should never be one stray gesture
    // away from dismissing the app, so the swipe goes first.
    attempt(() => app.disableVerticalSwipes?.());
    attempt(() => app.requestFullscreen?.());
    attempt(() => app.setHeaderColor?.('#e85d0b'));
    attempt(() => app.setBackgroundColor?.('#f7f7f5'));
    attempt(() => app.setBottomBarColor?.('#ffffff'));

    syncInsets();
    INSET_EVENTS.forEach(event => app.onEvent?.(event, syncInsets));
    // Older clients answer the fullscreen request after a beat; re-read then.
    const timers = [120, 500, 1200].map(delay => window.setTimeout(syncInsets, delay));

    return () => {
        timers.forEach(timer => window.clearTimeout(timer));
        INSET_EVENTS.forEach(event => app.offEvent?.(event, syncInsets));
    };
}

export function haptic(kind: 'select' | 'success' | 'error' | 'tap'): void {
    const feedback = telegram()?.HapticFeedback;
    if (!feedback) return;
    if (kind === 'select') feedback.selectionChanged();
    else if (kind === 'success') feedback.notificationOccurred('success');
    else if (kind === 'error') feedback.notificationOccurred('error');
    else feedback.impactOccurred('light');
}

export function openExternal(url: string): void {
    const app = telegram();
    if (app?.openLink) app.openLink(url);
    else window.open(url, '_blank', 'noopener');
}

export function closeApp(): void {
    telegram()?.close();
}
