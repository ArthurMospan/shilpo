/**
 * The public address of this deployment.
 *
 * Telegram opens the Mini App at this address and Silpo returns the OAuth code
 * to it, so a missing scheme is not a cosmetic problem: `new URL()` throws on
 * "example.com" and the Mini App button silently stops being valid. Hosting
 * dashboards show domains without a scheme, and it is easy to paste one that
 * way, so normalize instead of trusting the value.
 */
export function publicBaseUrl(): string {
    const raw = (process.env.WEBAPP_URL || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}
