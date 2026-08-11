import dotenv from 'dotenv';

dotenv.config();

// Model ids verified live against the models endpoint on 2026-08-11.
// gemini-2.5-flash is still listed there but answers 404 on generateContent,
// which is exactly why the fallback chain exists: a 404 means the model is
// gone for us, so we move to the next one instead of burning every key on a
// dead endpoint. Strongest model first — handwriting is the hard case.
const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'];
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 45_000;

// Keys that answered 401/403 are invalid or revoked. Skipping them for the
// lifetime of the process avoids re-uploading a photo to a dead key.
const deadKeys = new Set<string>();

function apiKeys(): string[] {
    return (process.env.GEMINI_API_KEY || '')
        .split(',')
        .map(key => key.trim())
        .filter(key => key.length > 10);
}

export function geminiConfigured(): boolean {
    return apiKeys().some(key => !deadKeys.has(key));
}

export interface GeminiPart {
    text?: string;
    inlineData?: { mimeType: string; data: string };
}

export class GeminiUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GeminiUnavailableError';
    }
}

interface GenerateOptions {
    parts: GeminiPart[];
    systemInstruction?: string;
    /** Response schema for structured output; forces JSON mode when present. */
    schema?: Record<string, any>;
    temperature?: number;
}

async function postToGemini(model: string, key: string, payload: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(`${ENDPOINT}/${model}:generateContent?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Calls Gemini, rotating across the configured keys. Quota errors (429) and
 * transient 5xx move to the next key; an exhausted rotation moves to the next
 * model before giving up.
 */
export async function generate(options: GenerateOptions): Promise<string> {
    const keys = apiKeys();
    if (!keys.length) throw new GeminiUnavailableError('GEMINI_API_KEY is not configured');

    const payload = JSON.stringify({
        contents: [{
            role: 'user',
            parts: options.parts.map(part => (part.inlineData
                ? { inline_data: { mime_type: part.inlineData.mimeType, data: part.inlineData.data } }
                : { text: part.text || '' })),
        }],
        ...(options.systemInstruction
            ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
            : {}),
        generationConfig: {
            temperature: options.temperature ?? 0.2,
            ...(options.schema
                ? { responseMimeType: 'application/json', responseSchema: options.schema }
                : {}),
        },
    });

    let lastError = '';
    for (const model of MODELS) {
        for (const key of keys) {
            if (deadKeys.has(key)) continue;
            try {
                const response = await postToGemini(model, key, payload);

                if (response.status === 404) {
                    lastError = `model ${model} is retired`;
                    console.warn(`[Gemini] ${model} → 404, trying the next model`);
                    break;
                }
                if (response.status === 401 || response.status === 403) {
                    console.warn(`[Gemini] key ${key.slice(0, 8)}… rejected (${response.status}); blacklisted for this process`);
                    deadKeys.add(key);
                    continue;
                }
                if (!response.ok) {
                    lastError = `HTTP ${response.status}`;
                    const body = await response.text().catch(() => '');
                    console.warn(`[Gemini] ${model} HTTP ${response.status}: ${body.slice(0, 200)}`);
                    continue;
                }

                const result: any = await response.json();
                const text = result?.candidates?.[0]?.content?.parts
                    ?.map((part: any) => part?.text || '')
                    .join('')
                    .trim();
                if (text) return text;
                lastError = 'empty response';
                console.warn(`[Gemini] ${model} returned no text`);
            } catch (error: any) {
                lastError = error?.message || String(error);
                console.warn(`[Gemini] request failed: ${lastError}`);
            }
        }
    }
    throw new GeminiUnavailableError(`All Gemini attempts failed (${lastError || 'unknown reason'})`);
}

/** Parses a JSON answer, tolerating markdown fences some models still emit. */
export function parseJsonAnswer<T>(text: string): T | null {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try {
        return JSON.parse(cleaned) as T;
    } catch {
        const start = cleaned.search(/[[{]/);
        const end = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
        if (start < 0 || end <= start) return null;
        try {
            return JSON.parse(cleaned.slice(start, end + 1)) as T;
        } catch {
            return null;
        }
    }
}
