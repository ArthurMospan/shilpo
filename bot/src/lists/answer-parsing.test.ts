import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAffirmative, isNegative, isRefusal, itemLabel, quantityFromAnswer } from './answer-parsing';

test('plain numbers and units are read without a model call', () => {
    assert.deepEqual(quantityFromAnswer('2'), { quantity: 2, unit: '' });
    assert.deepEqual(quantityFromAnswer('2 шт'), { quantity: 2, unit: 'шт' });
    assert.deepEqual(quantityFromAnswer('1,5 кг'), { quantity: 1.5, unit: 'кг' });
    assert.deepEqual(quantityFromAnswer(' 3 ПАЧ '), { quantity: 3, unit: 'пач' });
});

test('spelled-out numbers are understood', () => {
    assert.deepEqual(quantityFromAnswer('дві'), { quantity: 2, unit: '' });
    assert.deepEqual(quantityFromAnswer('Три'), { quantity: 3, unit: '' });
});

test('conversational replies fall through to the model', () => {
    assert.equal(quantityFromAnswer('візьми побільше'), null);
    assert.equal(quantityFromAnswer('2 пляшки соку і хліб'), null);
    assert.equal(quantityFromAnswer('0'), null, 'zero is not a quantity');
    assert.equal(quantityFromAnswer('200'), null, 'an out-of-range count is likely a price or weight');
});

test('yes and no are recognized without ambiguity', () => {
    assert.equal(isAffirmative('так'), true);
    assert.equal(isAffirmative('Так.'), true);
    assert.equal(isAffirmative('точно ні'), false);
    assert.equal(isNegative('ні'), true);
    assert.equal(isNegative('нізащо'), false);
});

test('an explicit refusal drops the line', () => {
    assert.equal(isRefusal('не треба'), true);
    assert.equal(isRefusal('Прибери'), true);
    assert.equal(isRefusal('не знаю'), false);
});

test('the label joins the query with its qualifier', () => {
    assert.equal(itemLabel({ query: 'молоко', note: '2,5%' }), 'молоко, 2,5%');
    assert.equal(itemLabel({ query: 'хліб', note: '' }), 'хліб');
});
