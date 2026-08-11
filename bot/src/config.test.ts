import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicBaseUrl } from './config';

function withWebappUrl<T>(value: string | undefined, run: () => T): T {
    const previous = process.env.WEBAPP_URL;
    if (value === undefined) delete process.env.WEBAPP_URL;
    else process.env.WEBAPP_URL = value;
    try {
        return run();
    } finally {
        if (previous === undefined) delete process.env.WEBAPP_URL;
        else process.env.WEBAPP_URL = previous;
    }
}

test('a bare domain gains https — dashboards show addresses without a scheme', () => {
    assert.equal(withWebappUrl('shilpo-three.vercel.app', publicBaseUrl), 'https://shilpo-three.vercel.app');
});

test('an address that already has a scheme is left alone', () => {
    assert.equal(withWebappUrl('https://shilpo.example', publicBaseUrl), 'https://shilpo.example');
    assert.equal(withWebappUrl('http://localhost:3000', publicBaseUrl), 'http://localhost:3000');
});

test('trailing slashes and stray whitespace are trimmed', () => {
    assert.equal(withWebappUrl('  https://shilpo.example//  ', publicBaseUrl), 'https://shilpo.example');
    assert.equal(withWebappUrl('shilpo.example/', publicBaseUrl), 'https://shilpo.example');
});

test('the result is always a URL that can be resolved against', () => {
    const base = withWebappUrl('shilpo-three.vercel.app', publicBaseUrl);
    assert.equal(new URL('/api/auth/start', base).toString(), 'https://shilpo-three.vercel.app/api/auth/start');
});

test('an unset address stays empty rather than becoming "https://"', () => {
    assert.equal(withWebappUrl(undefined, publicBaseUrl), '');
    assert.equal(withWebappUrl('   ', publicBaseUrl), '');
});
