import path from 'path';
import express from 'express';
import cors from 'cors';
import type { Telegraf } from 'telegraf';
import { buildAuthorizeUrl, completeAuthorization, isConnected, withSilpoToken, SilpoNotConnectedError } from '../silpo/auth';
import { getStoreContext } from '../silpo/store';
import { addProductsToCart, clearCart, getCartSummary, SILPO_BASKET_URL } from '../silpo/cart';
import { findProductsForQueries } from '../silpo/products';
import {
    getActiveList,
    getItem,
    getItems,
    getList,
    markDone,
    selectProduct,
    setCandidates,
    updateItem,
} from '../lists/repository';
import { buildSelection } from '../lists/flow';
import { requireTelegramUser } from '../auth/telegram-webapp';
import { verifyAuthLink } from '../auth/link';
import { resumePendingList, summarizeCartResult } from '../bot/conversation';
import { connectedPage, errorPage } from './pages';

export function createServer(bot: Telegraf) {
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '1mb' }));

    app.get('/health', (_req, res) => {
        // webappUrl is echoed because a mismatch between it and the real
        // public address silently breaks both the Mini App button and the
        // OAuth redirect — and that is invisible from the logs.
        res.json({
            status: 'ok',
            checkedAt: new Date().toISOString(),
            webappUrl: (process.env.WEBAPP_URL || '').trim().replace(/\/+$/, ''),
            database: process.env.TURSO_DATABASE_URL ? 'turso' : 'local-sqlite',
        });
    });

    // ── OAuth 2.1 PKCE ──────────────────────────────────────────────
    app.get('/auth/start', async (req, res) => {
        const tgId = Number(req.query.tg_id);
        const expiresAt = Number(req.query.exp);
        const signature = String(req.query.sig || '');
        if (!verifyAuthLink(tgId, expiresAt, signature)) {
            res.status(403).send(errorPage('Посилання застаріло', 'Поверніться в чат і натисніть «Підключити» ще раз.'));
            return;
        }
        try {
            const redirectUri = `${publicBaseUrl(req)}/auth/callback`;
            res.redirect(await buildAuthorizeUrl(tgId, redirectUri));
        } catch (error) {
            console.error('[OAuth] Failed to start authorization:', error);
            res.status(502).send(errorPage('Сільпо не відповідає', 'Спробуйте, будь ласка, ще раз за хвилину.'));
        }
    });

    app.get('/auth/callback', async (req, res) => {
        const code = String(req.query.code || '');
        const state = String(req.query.state || '');
        if (!code || !state) {
            res.status(400).send(errorPage('Невідома відповідь', 'Спробуйте підключити акаунт ще раз із чату.'));
            return;
        }
        try {
            const tgId = await completeAuthorization(code, state);
            res.send(connectedPage());

            // Continue the conversation the guest was in the middle of.
            await bot.telegram.sendMessage(
                tgId,
                '✅ <b>Кабінет Сільпо підключено!</b>\nТепер я бачу твій магазин, ціни й кошик.',
                { parse_mode: 'HTML' }
            ).catch(() => undefined);
            const active = await getActiveList(tgId);
            if (active) await resumePendingList(bot, tgId, active.listId).catch(error =>
                console.error('[OAuth] Failed to resume list:', error));
        } catch (error) {
            console.error('[OAuth] Token exchange failed:', error);
            res.status(502).send(errorPage('Не вдалося підключити', 'Спробуйте ще раз із чату — посилання діє 15 хвилин.'));
        }
    });

    // ── Mini App API ────────────────────────────────────────────────
    app.use('/api', requireTelegramUser);

    app.get('/api/list/:listId', async (req, res) => {
        const tgId = req.tgId!;
        const list = await getList(req.params.listId);
        if (!list || list.tgId !== tgId) {
            res.status(404).json({ error: 'List not found' });
            return;
        }

        const items = await getItems(list.listId);
        const selection = buildSelection(items);
        try {
            const { context, cart } = await withSilpoToken(tgId, async (token) => {
                const storeContext = await getStoreContext(token);
                return { context: storeContext, cart: await getCartSummary(token, storeContext.shoppingCartId) };
            });
            res.json({
                list: { listId: list.listId, stage: list.stage, storeLabel: context.storeLabel },
                store: context,
                cart: { itemCount: cart.itemCount, total: cart.total, isEmpty: cart.isEmpty },
                items: selection.lines.map(line => ({
                    itemId: line.item.itemId,
                    label: [line.item.query, line.item.note].filter(Boolean).join(', '),
                    rawText: line.item.rawText,
                    quantity: line.quantity,
                    unit: line.item.unit,
                    selectedProductId: line.item.selectedProductId,
                    candidates: line.item.candidates,
                })),
                totals: { total: selection.total, productCount: selection.productCount },
                basketUrl: SILPO_BASKET_URL,
            });
        } catch (error) {
            if (error instanceof SilpoNotConnectedError) {
                res.status(401).json({ error: 'Silpo account is not connected' });
                return;
            }
            console.error('[API] Failed to load list:', error);
            res.status(502).json({ error: 'Silpo is temporarily unavailable' });
        }
    });

    async function itemForRequest(req: express.Request): Promise<{ listId: string; itemId: string } | null> {
        const item = await getItem(String(req.body?.itemId || ''));
        if (!item || item.listId !== req.params.listId) return null;
        const list = await getList(item.listId);
        if (!list || list.tgId !== req.tgId) return null;
        return { listId: list.listId, itemId: item.itemId };
    }

    app.post('/api/list/:listId/select', async (req, res) => {
        const target = await itemForRequest(req);
        if (!target) {
            res.status(404).json({ error: 'Item not found' });
            return;
        }
        await selectProduct(target.itemId, String(req.body?.productId || ''));
        res.json({ ok: true, ...(await totalsFor(target.listId)) });
    });

    app.post('/api/list/:listId/quantity', async (req, res) => {
        const target = await itemForRequest(req);
        if (!target) {
            res.status(404).json({ error: 'Item not found' });
            return;
        }
        const quantity = Math.max(1, Math.min(99, Math.round(Number(req.body?.quantity) || 1)));
        await updateItem(target.itemId, { quantity, needsQuantity: false });
        res.json({ ok: true, quantity, ...(await totalsFor(target.listId)) });
    });

    app.post('/api/list/:listId/remove', async (req, res) => {
        const target = await itemForRequest(req);
        if (!target) {
            res.status(404).json({ error: 'Item not found' });
            return;
        }
        await updateItem(target.itemId, { dropped: Boolean(req.body?.dropped ?? true) });
        res.json({ ok: true, ...(await totalsFor(target.listId)) });
    });

    /** Widens the choice for one line when none of the first candidates fit. */
    app.post('/api/list/:listId/search', async (req, res) => {
        const tgId = req.tgId!;
        const target = await itemForRequest(req);
        if (!target) {
            res.status(404).json({ error: 'Item not found' });
            return;
        }
        const query = String(req.body?.query || '').trim().slice(0, 120);
        if (query.length < 2) {
            res.status(400).json({ error: 'Query is too short' });
            return;
        }
        try {
            const candidates = await withSilpoToken(tgId, async (token) => {
                const context = await getStoreContext(token);
                const [result] = await findProductsForQueries(token, context, [query], 12);
                return result?.candidates ?? [];
            });
            await setCandidates(target.itemId, candidates);
            if (candidates.length) await selectProduct(target.itemId, candidates[0].productId);
            res.json({ ok: true, candidates });
        } catch (error) {
            console.error('[API] Item search failed:', error);
            res.status(502).json({ error: 'Search failed' });
        }
    });

    app.post('/api/list/:listId/checkout', async (req, res) => {
        const tgId = req.tgId!;
        const list = await getList(req.params.listId);
        if (!list || list.tgId !== tgId) {
            res.status(404).json({ error: 'List not found' });
            return;
        }
        const mode = req.body?.mode === 'replace' ? 'replace' : 'append';
        const selection = buildSelection(await getItems(list.listId));
        if (!selection.chosen.length) {
            res.status(400).json({ error: 'Nothing selected' });
            return;
        }

        try {
            const result = await withSilpoToken(tgId, async (token) => {
                const context = await getStoreContext(token);
                if (mode === 'replace') await clearCart(token, context.shoppingCartId);
                const added = await addProductsToCart(
                    token,
                    context.shoppingCartId,
                    context.branchId,
                    selection.chosen.map(line => ({
                        productId: line.product!.productId,
                        companyId: line.product!.companyId,
                        quantity: line.quantity,
                    }))
                );
                const cart = await getCartSummary(token, context.shoppingCartId);
                return { added, cart, context };
            });

            await markDone(list.listId);
            await bot.telegram.sendMessage(
                tgId,
                `${summarizeCartResult(result.added, result.cart.total, mode)}\n\n` +
                `Магазин: ${result.context.storeLabel}\n` +
                'Залишилось підтвердити замовлення в Сільпо 👇',
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: '🧾 Оформити замовлення', url: SILPO_BASKET_URL }]],
                    },
                }
            ).catch(() => undefined);

            res.json({
                ok: true,
                added: result.added,
                cartTotal: result.cart.total,
                cartItemCount: result.cart.itemCount,
                basketUrl: SILPO_BASKET_URL,
            });
        } catch (error) {
            if (error instanceof SilpoNotConnectedError) {
                res.status(401).json({ error: 'Silpo account is not connected' });
                return;
            }
            console.error('[API] Checkout failed:', error);
            res.status(502).json({ error: 'Failed to update the Silpo cart' });
        }
    });

    app.get('/api/status', async (req, res) => {
        const tgId = req.tgId!;
        const active = await getActiveList(tgId);
        res.json({ connected: await isConnected(tgId), activeListId: active?.listId ?? null });
    });

    // ── Mini App static assets ──────────────────────────────────────
    const webappDist = path.resolve(__dirname, '../../../webapp/dist');
    app.use(express.static(webappDist));
    app.get(/.*/, (req, res, next) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
        res.sendFile(path.join(webappDist, 'index.html'));
    });

    return app;
}

async function totalsFor(listId: string) {
    const selection = buildSelection(await getItems(listId));
    return { total: selection.total, productCount: selection.productCount };
}

function publicBaseUrl(req: express.Request): string {
    const configured = (process.env.WEBAPP_URL || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
}

export function startServer(bot: Telegraf, port = Number(process.env.PORT) || 3000): void {
    const host = process.env.SERVER_HOST || '0.0.0.0';
    createServer(bot).listen(port, host, () => {
        console.log(`✅ API and Mini App listening on ${host}:${port}`);
    });
}
