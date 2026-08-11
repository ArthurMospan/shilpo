import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, formatQuantity, itemLabel, pluralizeItems, pluralizeProducts } from './format';

test('HTML entities in guest text cannot break the message markup', () => {
    assert.equal(escapeHtml('<b>сир</b> & "твердий"'), '&lt;b&gt;сир&lt;/b&gt; &amp; "твердий"');
});

test('quantities print without a trailing ,00 for whole numbers', () => {
    assert.equal(formatQuantity({ quantity: 2, unit: 'шт' }), '2 шт');
    assert.equal(formatQuantity({ quantity: 1.5, unit: 'кг' }), '1,50 кг');
    assert.equal(formatQuantity({ quantity: 1, unit: '' }), '1 шт');
});

test('Ukrainian plurals follow the 1 / 2-4 / 5+ rule', () => {
    assert.equal(pluralizeItems(1), 'позиція');
    assert.equal(pluralizeItems(3), 'позиції');
    assert.equal(pluralizeItems(5), 'позицій');
    assert.equal(pluralizeItems(11), 'позицій', '11 takes the many form');
    assert.equal(pluralizeItems(21), 'позиція');
    assert.equal(pluralizeItems(22), 'позиції');
    assert.equal(pluralizeProducts(1), 'товар');
    assert.equal(pluralizeProducts(14), 'товарів');
});

test('the label drops an empty qualifier', () => {
    assert.equal(itemLabel({ query: 'молоко', note: '2,5%' }), 'молоко, 2,5%');
    assert.equal(itemLabel({ query: 'хліб', note: '' }), 'хліб');
});
