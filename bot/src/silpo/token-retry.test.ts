import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpUnauthorizedError } from './mcp';
import { withRefreshOnce } from './token-retry';

const rejected = () => new McpUnauthorizedError('MCP rejected the access token (HTTP 401)');

test('a refreshed token Silpo still rejects ends the session instead of failing forever', async () => {
    const tried: string[] = [];
    let revoked = false;
    const result = withRefreshOnce(
        'old',
        async token => { tried.push(token); throw rejected(); },
        async () => 'fresh',
        async () => { revoked = true; throw new Error('reconnect'); }
    );
    await assert.rejects(result, /reconnect/);
    assert.deepEqual(tried, ['old', 'fresh']);
    assert.equal(revoked, true);
});

test('a token that cannot be refreshed ends the session', async () => {
    let revoked = false;
    const result = withRefreshOnce(
        'old',
        async () => { throw rejected(); },
        async () => null,
        async () => { revoked = true; throw new Error('reconnect'); }
    );
    await assert.rejects(result, /reconnect/);
    assert.equal(revoked, true);
});

test('a refreshed token that works keeps the session', async () => {
    const result = await withRefreshOnce(
        'old',
        async token => { if (token === 'old') throw rejected(); return 'cart'; },
        async () => 'fresh',
        async () => { throw new Error('should not revoke'); }
    );
    assert.equal(result, 'cart');
});

test('a Silpo outage is not mistaken for an ended session', async () => {
    let refreshed = false;
    const result = withRefreshOnce(
        'old',
        async () => { throw new Error('MCP HTTP 503'); },
        async () => { refreshed = true; return 'fresh'; },
        async () => { throw new Error('should not revoke'); }
    );
    await assert.rejects(result, /MCP HTTP 503/);
    assert.equal(refreshed, false);
});
