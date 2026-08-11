// Thin JSON-RPC client for the official Silpo MCP server.
//
// The MCP spec's Streamable HTTP transport is a plain HTTP POST of a JSON-RPC
// envelope, so a direct fetch keeps the dependency surface small and lets us
// control retries and timeouts precisely. The guest's Silpo JWT never reaches
// this process — we only ever hold the OAuth access token issued by MCP.

export const MCP_BASE = 'https://mcp.silpo.ua';

const REQUEST_TIMEOUT_MS = 30_000;

export class McpUnauthorizedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'McpUnauthorizedError';
    }
}

export class McpError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'McpError';
    }
}

async function callMcp(token: string, method: string, params?: Record<string, any>): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
        response = await fetch(`${MCP_BASE}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, ...(params ? { params } : {}) }),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    if (response.status === 401 || response.status === 403) {
        throw new McpUnauthorizedError(`MCP rejected the access token (HTTP ${response.status})`);
    }

    const raw = await response.text();
    const data = parseJsonRpcBody(raw);

    if (!response.ok) throw new McpError(`MCP HTTP ${response.status}: ${raw.slice(0, 400)}`);
    if (data?.error) throw new McpError(`MCP error: ${JSON.stringify(data.error).slice(0, 400)}`);
    if (data?.result?.isError) throw new McpError(`MCP tool error: ${JSON.stringify(data.result.content).slice(0, 400)}`);
    return data;
}

// Streamable HTTP may answer either with a JSON body or with an SSE stream
// whose frames carry the same JSON-RPC envelope. Accept both.
export function parseJsonRpcBody(raw: string): any {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
        try { return JSON.parse(trimmed); } catch { return null; }
    }
    const payloads = trimmed
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .filter(Boolean);
    for (const payload of payloads.reverse()) {
        try {
            const parsed = JSON.parse(payload);
            if (parsed?.result || parsed?.error) return parsed;
        } catch {
            // Keep looking: heartbeat frames are not JSON.
        }
    }
    return null;
}

export async function callMCPTool(token: string, toolName: string, args: Record<string, any> = {}): Promise<any> {
    return callMcp(token, 'tools/call', { name: toolName, arguments: args });
}

export async function listMCPTools(token: string): Promise<{ name: string }[]> {
    const response = await callMcp(token, 'tools/list');
    return Array.isArray(response?.result?.tools) ? response.result.tools : [];
}

/** MCP returns tool payloads as JSON encoded inside text content blocks. */
export function parseMcpContent(response: any): any[] {
    const content = response?.result?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((item: any) => {
        if (item?.type !== 'text' || typeof item.text !== 'string') return [];
        try { return [JSON.parse(item.text)]; } catch { return []; }
    });
}

export function firstMcpObject(response: any): any {
    for (const value of parseMcpContent(response)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    }
    return {};
}

/** Depth-first search for a key anywhere in an MCP payload. */
export function findDeep(value: any, keys: string[], visited = new Set<any>()): any {
    if (!value || typeof value !== 'object' || visited.has(value)) return undefined;
    visited.add(value);
    if (!Array.isArray(value)) {
        for (const key of keys) {
            if (value[key] !== undefined && value[key] !== null) return value[key];
        }
    }
    for (const nested of Array.isArray(value) ? value : Object.values(value)) {
        const found = findDeep(nested, keys, visited);
        if (found !== undefined) return found;
    }
    return undefined;
}
