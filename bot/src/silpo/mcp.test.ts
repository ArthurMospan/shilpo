import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findDeep, firstMcpObject, parseJsonRpcBody, parseMcpContent } from './mcp';

test('a plain JSON body is parsed as-is', () => {
    const parsed = parseJsonRpcBody('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}');
    assert.deepEqual(parsed.result, { content: [] });
});

test('an SSE stream yields the last JSON-RPC frame', () => {
    const stream = [
        'event: message',
        'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}',
        '',
    ].join('\n');

    const parsed = parseJsonRpcBody(stream);
    assert.equal(parsed.result.content[0].type, 'text');
    assert.deepEqual(parseMcpContent(parsed), [{ ok: true }]);
});

test('heartbeat frames without JSON do not break parsing', () => {
    const stream = 'data: ping\n\ndata: {"jsonrpc":"2.0","result":{"content":[]}}\n';
    assert.deepEqual(parseJsonRpcBody(stream).result, { content: [] });
});

test('an empty body parses to null instead of throwing', () => {
    assert.equal(parseJsonRpcBody(''), null);
    assert.equal(parseJsonRpcBody('   '), null);
});

test('non-JSON text content blocks are skipped', () => {
    const response = { result: { content: [{ type: 'text', text: 'not json' }, { type: 'text', text: '{"a":1}' }] } };
    assert.deepEqual(parseMcpContent(response), [{ a: 1 }]);
    assert.deepEqual(firstMcpObject(response), { a: 1 });
});

test('findDeep locates a key nested under arrays and objects', () => {
    const payload = { data: { shipments: [{ meta: { branchId: '42' } }] } };
    assert.equal(findDeep(payload, ['branchId']), '42');
    assert.equal(findDeep(payload, ['missing']), undefined);
});
