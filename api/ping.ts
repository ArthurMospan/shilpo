// Temporary diagnostic: a function with a plain filename and no imports.
// If /api/ping answers JSON while /api/health does not, the catch-all route is
// the problem rather than the api/ directory being ignored altogether.
import type { IncomingMessage, ServerResponse } from 'http';

export default function handler(_req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ping: 'ok', at: new Date().toISOString() }));
}
