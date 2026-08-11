import crypto from 'crypto';
import db from '../db/index';
import { MCP_BASE, McpUnauthorizedError } from './mcp';

// Silpo MCP implements OAuth 2.1 + PKCE with Dynamic Client Registration.
// Each guest gets their own registered client so a revoked consent affects
// only that guest.

interface PendingAuth {
    clientId: string;
    codeVerifier: string;
    tgId: number;
    redirectUri: string;
}

const PENDING_TTL_SECONDS = 10 * 60;

// Keyed by the `state` parameter so several guests can authorize at once — a
// single shared slot would hand guest A's code to guest B's session. Stored in
// the database rather than in memory because /auth/start and /auth/callback are
// two separate requests that need not reach the same process.
async function rememberPendingAuth(state: string, pending: PendingAuth): Promise<void> {
    await db.prepare(`
        INSERT INTO oauth_states (state, tg_id, client_id, code_verifier, redirect_uri, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        state,
        pending.tgId,
        pending.clientId,
        pending.codeVerifier,
        pending.redirectUri,
        Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS
    );
}

/** Reads a pending handshake and consumes it, so an authorization code cannot be replayed. */
async function takePendingAuth(state: string): Promise<PendingAuth | null> {
    const row = await db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
    await db.prepare('DELETE FROM oauth_states WHERE state = ? OR expires_at < ?')
        .run(state, Math.floor(Date.now() / 1000));
    if (!row || Number(row.expires_at) <= Math.floor(Date.now() / 1000)) return null;
    return {
        tgId: Number(row.tg_id),
        clientId: String(row.client_id),
        codeVerifier: String(row.code_verifier),
        redirectUri: String(row.redirect_uri),
    };
}

function codeChallengeFor(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function registerClient(redirectUri: string): Promise<string> {
    const response = await fetch(`${MCP_BASE}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_name: 'Шільпо — списки покупок',
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        }),
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok || !data?.client_id) {
        throw new Error(`Dynamic client registration failed (HTTP ${response.status}): ${JSON.stringify(data).slice(0, 300)}`);
    }
    return String(data.client_id);
}

export async function buildAuthorizeUrl(tgId: number, redirectUri: string): Promise<string> {
    const clientId = await registerClient(redirectUri);
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    await rememberPendingAuth(state, { clientId, codeVerifier, tgId, redirectUri });

    const authorizeUrl = new URL(`${MCP_BASE}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('code_challenge', codeChallengeFor(codeVerifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', state);
    return authorizeUrl.toString();
}

async function persistTokens(tgId: number, clientId: string, tokens: any): Promise<void> {
    const expiresIn = Number(tokens?.expires_in);
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
        ? Math.floor(Date.now() / 1000) + expiresIn
        : null;
    await db.prepare('INSERT OR IGNORE INTO users (tg_id) VALUES (?)').run(tgId);
    await db.prepare(`
        UPDATE users
        SET mcp_token = ?, mcp_refresh_token = ?, mcp_client_id = ?, mcp_expires_at = ?
        WHERE tg_id = ?
    `).run(
        String(tokens.access_token),
        tokens.refresh_token ? String(tokens.refresh_token) : null,
        clientId,
        expiresAt,
        tgId
    );
    tokenCache.set(tgId, String(tokens.access_token));
}

/** Exchanges the authorization code. Returns the Telegram id that started the flow. */
export async function completeAuthorization(code: string, state: string): Promise<number> {
    const pending = await takePendingAuth(state);
    if (!pending) throw new Error('Unknown or expired OAuth state');

    const response = await fetch(`${MCP_BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: pending.clientId,
            code,
            redirect_uri: pending.redirectUri,
            code_verifier: pending.codeVerifier,
        }).toString(),
    });
    const tokens: any = await response.json().catch(() => ({}));
    if (!response.ok || !tokens?.access_token) {
        throw new Error(`Token exchange failed (HTTP ${response.status}): ${JSON.stringify(tokens).slice(0, 300)}`);
    }

    await persistTokens(pending.tgId, pending.clientId, tokens);
    return pending.tgId;
}

const tokenCache = new Map<number, string>();

export async function tokenForUser(tgId: number): Promise<string | null> {
    const cached = tokenCache.get(tgId);
    if (cached) return cached;
    const row = await db.prepare('SELECT mcp_token FROM users WHERE tg_id = ?').get(tgId);
    const token = row?.mcp_token ? String(row.mcp_token) : '';
    if (token) tokenCache.set(tgId, token);
    return token || null;
}

export async function isConnected(tgId: number): Promise<boolean> {
    return Boolean(await tokenForUser(tgId));
}

export async function disconnect(tgId: number): Promise<void> {
    tokenCache.delete(tgId);
    await db.prepare(`
        UPDATE users SET mcp_token = NULL, mcp_refresh_token = NULL, mcp_expires_at = NULL WHERE tg_id = ?
    `).run(tgId);
}

async function refreshToken(tgId: number): Promise<string | null> {
    const row = await db.prepare('SELECT mcp_refresh_token, mcp_client_id FROM users WHERE tg_id = ?').get(tgId);
    const refresh = row?.mcp_refresh_token ? String(row.mcp_refresh_token) : '';
    const clientId = row?.mcp_client_id ? String(row.mcp_client_id) : '';
    if (!refresh || !clientId) return null;

    const response = await fetch(`${MCP_BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh }).toString(),
    });
    const tokens: any = await response.json().catch(() => ({}));
    if (!response.ok || !tokens?.access_token) {
        console.warn(`[Auth] Refresh failed for ${tgId} (HTTP ${response.status})`);
        return null;
    }
    // A rotating refresh token is only returned on rotation; keep the old one otherwise.
    await persistTokens(tgId, clientId, { ...tokens, refresh_token: tokens.refresh_token || refresh });
    return String(tokens.access_token);
}

export class SilpoNotConnectedError extends Error {
    constructor() {
        super('Silpo account is not connected');
        this.name = 'SilpoNotConnectedError';
    }
}

/**
 * Runs an MCP operation with the guest's token, transparently refreshing once
 * if Silpo reports the token as expired.
 */
export async function withSilpoToken<T>(tgId: number, operation: (token: string) => Promise<T>): Promise<T> {
    const token = await tokenForUser(tgId);
    if (!token) throw new SilpoNotConnectedError();
    try {
        return await operation(token);
    } catch (error) {
        if (!(error instanceof McpUnauthorizedError)) throw error;
        tokenCache.delete(tgId);
        const refreshed = await refreshToken(tgId);
        if (!refreshed) {
            await disconnect(tgId);
            throw new SilpoNotConnectedError();
        }
        return operation(refreshed);
    }
}
