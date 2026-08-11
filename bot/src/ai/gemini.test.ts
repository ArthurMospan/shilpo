import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJsonAnswer } from './gemini';

test('a clean JSON answer parses directly', () => {
    assert.deepEqual(parseJsonAnswer<{ a: number }>('{"a":1}'), { a: 1 });
});

test('markdown fences around the JSON are stripped', () => {
    assert.deepEqual(parseJsonAnswer<number[]>('```json\n[1,2,3]\n```'), [1, 2, 3]);
    assert.deepEqual(parseJsonAnswer<number[]>('```\n[4]\n```'), [4]);
});

test('prose wrapped around the JSON is discarded', () => {
    const answer = 'Ось результат:\n[{"query":"молоко"}]\nСподіваюсь, це допоможе.';
    assert.deepEqual(parseJsonAnswer<any[]>(answer), [{ query: 'молоко' }]);
});

test('an unparseable answer returns null instead of throwing', () => {
    assert.equal(parseJsonAnswer('вибач, не можу'), null);
    assert.equal(parseJsonAnswer('{"broken":'), null);
});
