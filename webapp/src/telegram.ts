interface TelegramWebApp {
    initData: string;
    initDataUnsafe?: { user?: { id?: number; first_name?: string } };
    ready(): void;
    expand(): void;
    close(): void;
    openLink(url: string, options?: { try_instant_view?: boolean }): void;
    setHeaderColor?(color: string): void;
    setBackgroundColor?(color: string): void;
    HapticFeedback?: {
        impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
        notificationOccurred(type: 'error' | 'success' | 'warning'): void;
        selectionChanged(): void;
    };
    BackButton?: { show(): void; hide(): void; onClick(handler: () => void): void };
}

declare global {
    interface Window {
        Telegram?: { WebApp?: TelegramWebApp };
    }
}

export function telegram(): TelegramWebApp | undefined {
    return window.Telegram?.WebApp;
}

export function initTelegram(): void {
    const app = telegram();
    if (!app) return;
    app.ready();
    app.expand();
    app.setHeaderColor?.('#e85d0b');
    app.setBackgroundColor?.('#f7f7f5');
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
