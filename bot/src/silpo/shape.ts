/**
 * A payload's shape, with nothing in it worth protecting.
 *
 * We need to know what Silpo actually calls the free-delivery threshold, and
 * the honest way to find out is to look at a real answer. But a real cart
 * carries a real person: their delivery address, their name, their phone. So
 * this keeps what answers the question — the key names and the numbers — and
 * throws away every string that could be any of those.
 *
 * Numeric strings survive as themselves: a threshold quoted as "1000" is the
 * thing we came looking for, and no one's address looks like that.
 */

const NUMERIC = /^-?\d+([.,]\d+)?$/;
const MAX_DEPTH = 6;
/** One element is enough to show what an array holds. */
const ARRAY_SAMPLE = 1;

export function shapeOf(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return NUMERIC.test(value.trim()) ? value : '‹str›';
    if (typeof value !== 'object') return `‹${typeof value}›`;
    if (depth >= MAX_DEPTH) return '‹…›';

    if (Array.isArray(value)) {
        if (!value.length) return [];
        const sample = value.slice(0, ARRAY_SAMPLE).map(item => shapeOf(item, depth + 1));
        return value.length > ARRAY_SAMPLE ? [...sample, `‹+${value.length - ARRAY_SAMPLE} more›`] : sample;
    }

    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        out[key] = shapeOf(nested, depth + 1);
    }
    return out;
}
