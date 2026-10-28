import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModifierSheet } from '@/waiter_mobile/ModifierSheet';

// The handset shows a price; the hub decides it. If the two ever disagree, the waiter sees one
// number and the guest is billed another -- or the hub refuses the order at the table.
//
// So this does not check the sheet against a description of the hub: it hands what the sheet
// emits, mapped exactly the way OrderDraftDrawer builds an order line, to the hub's real
// priceOrder(), and requires the hub to accept it at the same price the waiter was shown.

const RESTAURANT_ID = 'contract-test';

const DAL = {
  id: 'dal', name: 'Dal Tadka', price: 220, isVeg: true, available: true,
  modifier_groups: [
    { id: 'spice', label: 'Spice', min: 1, max: 1, options: [
      { id: 'mild', label: 'Mild', price_delta: 0 },
      { id: 'hot', label: 'Hot', price_delta: 0 }
    ] },
    { id: 'extras', label: 'Extras', min: 0, max: 2, options: [
      { id: 'ghee', label: 'Extra ghee', price_delta: 30 },
      { id: 'jeera', label: 'Jeera rice', price_delta: 80 },
      { id: 'onion', label: 'No onion', price_delta: -10 }
    ] }
  ]
};

let priceOrder;
let dataDir;

beforeAll(async () => {
  // The hub's modules read HUB_DATA_DIR when they load. Point it somewhere disposable first, so
  // nothing here can touch the repository's real hub_server/data.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-contract-'));
  vi.stubEnv('HUB_DATA_DIR', dataDir);
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');

  ({ priceOrder } = await import('../../../hub_server/lib/pricing.js'));
  const { restaurantCache } = await import('../../../hub_server/lib/restaurantCache.js');
  // The same seam the hub's own pricing tests use.
  restaurantCache.getMenuCache = () => ({ uninitialized: false, items: [DAL] });
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// What OrderDraftDrawer sends for one cart row (src/waiter_mobile/OrderDraftDrawer.jsx).
const orderLine = row => ({
  id: row.item_id,
  name: row.name,
  qty: 1,
  price: row.price,
  ...(row.variant_id ? { variant_id: row.variant_id } : {}),
  ...(row.modifiers?.length ? { modifiers: row.modifiers.map(m => ({ group_id: m.group_id, option_id: m.option_id })) } : {})
});

async function compose(labels) {
  const onConfirm = vi.fn();
  // The row the waiter app hands the sheet: the menu item resolved to an item_id.
  render(<ModifierSheet row={{ ...DAL, item_id: DAL.id }} onConfirm={onConfirm} onClose={() => {}} />);
  for (const label of labels) await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }));
  await userEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
  return onConfirm.mock.calls[0][0];
}

describe('waiter sheet ↔ hub pricing', () => {
  const cases = [
    ['a required choice alone', ['Mild'], 220],
    ['a paid extra', ['Hot', 'Extra ghee'], 250],
    ['two extras, the group maximum', ['Mild', 'Extra ghee', 'Jeera rice'], 330],
    ['a choice that takes money off', ['Hot', 'Jeera rice', 'No onion'], 290]
  ];

  for (const [what, labels, expected] of cases) {
    it(`${what}: the hub accepts the order at the price the waiter was shown`, async () => {
      const row = await compose(labels);
      expect(row.price).toBe(expected);

      const priced = priceOrder([orderLine(row)], RESTAURANT_ID);
      expect(priced.rejected ?? []).toEqual([]);
      expect(priced.ok).toBe(true);
      expect(priced.items[0].price).toBe(row.price);
      expect(priced.total_amount).toBe(expected);
    });
  }

  it('the hub would refuse what the sheet refuses to send -- so blocking it at the table is right', () => {
    // No spice chosen: the sheet will not emit this, and the hub agrees it is not an order.
    const priced = priceOrder([{ id: 'dal', qty: 1, modifiers: [{ group_id: 'extras', option_id: 'ghee' }] }], RESTAURANT_ID);
    expect(priced.ok).toBe(false);
  });
});
