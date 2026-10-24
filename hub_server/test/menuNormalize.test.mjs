import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCloudMenuItem, normalizeStation } from '../lib/menuNormalize.js';

const LONG = 'Half-with-a-really-long-label-that-exceeds-forty-chars';

const FULL_ROW = {
  id: 'abc', name: 'Test Dish', price: '250.5', category_name: 'Mains', is_veg: false, available: false,
  variants: [
    { id: 'v1', label: LONG, price: '100' },
    { id: 'v2', label: 'No price', price: 'abc' },
    { label: 'No id', price: 5 },
    { id: 'v3', label: 'Full', price: 200, available: false }
  ],
  modifier_groups: [
    { id: 'g1', label: 'Spice', min: '1', max: '1', options: [
      { id: 'o1', label: 'Mild', price_delta: 0 },
      { id: 'o2', label: 'Bad', price_delta: 'x' },
      { id: 'o3', label: 'Hot', price_delta: '10', available: false }
    ] },
    { id: 'g2', label: 'Empty', options: [{ id: 'x', label: 'x', price_delta: 'nope' }] },
    { label: 'No id', options: [] }
  ],
  day_parts: [
    { id: 'dp1', label: 'Lunch', starts_at: '11:00', ends_at: '15:00', days: [1, 2, '3', 9, -1, 1.5], price: 180 },
    { id: 'dp2', label: 'Bad time', starts_at: '25:00', ends_at: '15:00', price: 1 },
    { id: 'dp3', label: 'No price', starts_at: '11:00', ends_at: '12:00' },
    { id: 'dp4', label: 'Per variant', starts_at: '18:00', ends_at: '20:00', variant_prices: { v1: 90, v3: '-5', v9: 'x' } }
  ],
  station: 'BAR'
};

test('normalizeCloudMenuItem keeps valid nested data and drops malformed entries', () => {
  assert.deepEqual(normalizeCloudMenuItem(FULL_ROW), {
    id: 'abc', name: 'Test Dish', price: 250.5, category: 'Mains', isVeg: false, available: false,
    variants: [
      { id: 'v1', label: LONG.slice(0, 40), price: 100, available: true },
      { id: 'v3', label: 'Full', price: 200, available: false }
    ],
    modifier_groups: [
      { id: 'g1', label: 'Spice', min: 1, max: 1, options: [
        { id: 'o1', label: 'Mild', price_delta: 0, available: true },
        { id: 'o3', label: 'Hot', price_delta: 10, available: false }
      ] }
    ],
    day_parts: [
      { id: 'dp1', label: 'Lunch', starts_at: '11:00', ends_at: '15:00', days: [1, 2, 3], price: 180 },
      { id: 'dp4', label: 'Per variant', starts_at: '18:00', ends_at: '20:00', variant_prices: { v1: 90 } }
    ],
    station: 'bar'
  });
});

test('normalizeCloudMenuItem applies the legacy defaults and adds no optional keys', () => {
  assert.deepEqual(normalizeCloudMenuItem({ id: 'm', name: 'Plain', price: 90 }), {
    id: 'm', name: 'Plain', price: 90, category: 'General', isVeg: true, available: true
  });
});

test('normalizeCloudMenuItem accepts camelCase rows and coerces a bad price to 0', () => {
  assert.deepEqual(normalizeCloudMenuItem({ id: 'm', name: 'X', price: 'abc', category: 'Starters', isVeg: false }), {
    id: 'm', name: 'X', price: 0, category: 'Starters', isVeg: false, available: true
  });
});

test('normalizeStation lowercases and leaves blanks undefined', () => {
  assert.equal(normalizeStation('COLD'), 'cold');
  assert.equal(normalizeStation(''), undefined);
  assert.equal(normalizeStation(undefined), undefined);
});
