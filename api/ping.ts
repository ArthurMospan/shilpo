// Temporary diagnostic: reports exactly what a rewritten request looks like by
// the time it reaches a function, so the real entry point can reconstruct the
// original path instead of guessing at Vercel's substitution syntax.
import type { IncomingMessage, ServerResponse } from 'http';

export default function handler(req: IncomingMessage, res: ServerResponse) {
    const interesting = Object.fromEntries(
        Object.entries(req.headers).filter(([key]) => key.startsWith('x-vercel') || key.startsWith('x-forwarded'))
    );
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: req.url, method: req.method, headers: interesting }, null, 2));
}
