import path from 'path';
import dotenv from 'dotenv';
import { createClient, type Client, type InArgs, type ResultSet } from '@libsql/client';

dotenv.config();

const tursoUrl = process.env.TURSO_DATABASE_URL;
const turso: Client | null = tursoUrl
    ? createClient({ url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN })
    : null;

// better-sqlite3 is a native module and only exists for local development.
// Requiring it lazily keeps it out of the serverless bundle, where Turso is
// always configured and a native build would fail to load.
function openLocalDatabase(): any {
    // The module name is assembled at runtime on purpose: a literal would let
    // the serverless bundler trace this native dependency and try to ship it,
    // which fails to load on Vercel. This branch never runs there — Turso is
    // always configured in the cloud.
    const moduleName = ['better', 'sqlite3'].join('-');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require(moduleName);
    const database = new Database(process.env.DATABASE_PATH || path.resolve(__dirname, '../../database.sqlite'));
    database.pragma('foreign_keys = ON');
    return database;
}

const local: any = turso ? null : openLocalDatabase();

const schemaStatements = [
    `CREATE TABLE IF NOT EXISTS users (
        tg_id INTEGER PRIMARY KEY,
        mcp_token TEXT,
        mcp_refresh_token TEXT,
        mcp_client_id TEXT,
        mcp_expires_at INTEGER,
        first_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    // One row per shopping list the guest starts. `stage` drives the chat
    // state machine, so a restart of the process never loses a conversation.
    `CREATE TABLE IF NOT EXISTS lists (
        list_id TEXT PRIMARY KEY,
        tg_id INTEGER NOT NULL,
        stage TEXT NOT NULL DEFAULT 'parsing',
        source TEXT NOT NULL DEFAULT 'text',
        raw_input TEXT,
        branch_id TEXT,
        delivery_type TEXT,
        store_label TEXT,
        question_index INTEGER DEFAULT 0,
        chat_message_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(tg_id) REFERENCES users(tg_id) ON DELETE CASCADE
    )`,
    // One row per recognized line of the guest's list. `candidates` holds the
    // Silpo search results as JSON so the Mini App can render them instantly.
    `CREATE TABLE IF NOT EXISTS list_items (
        item_id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        raw_text TEXT NOT NULL,
        query TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 1,
        unit TEXT,
        note TEXT,
        needs_quantity INTEGER DEFAULT 0,
        clarification TEXT,
        candidates TEXT,
        selected_product_id TEXT,
        dropped INTEGER DEFAULT 0,
        FOREIGN KEY(list_id) REFERENCES lists(list_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id, position)`,
    `CREATE INDEX IF NOT EXISTS idx_lists_user ON lists(tg_id, updated_at)`,
    // The OAuth handshake spans two requests that may land on different
    // serverless instances, so the PKCE verifier cannot live in process memory.
    `CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        tg_id INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    )`,
];

function normalizeArgs(args: unknown[]): InArgs {
    return args.map(value => (value === undefined ? null : value)) as InArgs;
}

async function executeRemote(sql: string, args: unknown[] = []): Promise<ResultSet> {
    if (!turso) throw new Error('Turso is not configured');
    return turso.execute({ sql, args: normalizeArgs(args) });
}

async function runSchemaStatement(sql: string): Promise<void> {
    if (turso) await turso.execute(sql);
    else local!.exec(sql);
}

async function bootstrap(): Promise<void> {
    for (const statement of schemaStatements) await runSchemaStatement(statement);

    // Additive migrations for databases created by an earlier release.
    for (const [table, column, type] of [
        ['users', 'mcp_refresh_token', 'TEXT'],
        ['users', 'mcp_client_id', 'TEXT'],
        ['users', 'mcp_expires_at', 'INTEGER'],
        ['lists', 'chat_message_id', 'INTEGER'],
    ] as const) {
        try {
            await runSchemaStatement(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        } catch {
            // The column already exists on an initialized database.
        }
    }
}

export const dbReady = bootstrap();

const db = {
    prepare(sql: string) {
        return {
            async get(...args: unknown[]): Promise<any> {
                await dbReady;
                if (turso) return (await executeRemote(sql, args)).rows[0] || undefined;
                return local!.prepare(sql).get(...(args as any[]));
            },
            async all(...args: unknown[]): Promise<any[]> {
                await dbReady;
                if (turso) return (await executeRemote(sql, args)).rows as any[];
                return local!.prepare(sql).all(...(args as any[])) as any[];
            },
            async run(...args: unknown[]): Promise<{ changes: number }> {
                await dbReady;
                if (turso) {
                    const result = await executeRemote(sql, args);
                    return { changes: Number(result.rowsAffected || 0) };
                }
                const result = local!.prepare(sql).run(...(args as any[]));
                return { changes: result.changes };
            },
        };
    },
};

export const usingTurso = Boolean(turso);
export default db;
