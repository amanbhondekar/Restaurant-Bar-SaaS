import React, { useCallback, useEffect, useState } from 'react';

import { Feedback } from './Feedback';
import { Basket } from './Basket';
import { addToBasket, basketCount, removeFromBasket } from './lib/basket';

// The menu a guest sees after scanning the code on their table (M4 · diner QR menu).
//
// Read-only on purpose: ordering and paying from here is the next slice and needs a payment
// provider decided first. Everything is served by the hub on the restaurant's own wifi, so this
// keeps working during an internet outage exactly like the rest of the product.

const money = (currency, n) => `${currency}${Number(n).toLocaleString('en-IN')}`;

/** A dish priced by size shows a range; one price otherwise. */
function PriceLabel({ currency, item }) {
  if (!item.variants) return <span className="price">{money(currency, item.price)}</span>;
  const prices = item.variants.map(v => v.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return (
    <span className="price">
      {low === high ? money(currency, low) : `${money(currency, low)} – ${money(currency, high)}`}
    </span>
  );
}

function Item({ currency, item, onAdd }) {
  return (
    <li className="item">
      <div className="item-head">
        <span className={item.is_veg ? 'dot veg' : 'dot nonveg'} aria-hidden="true" />
        <span className="item-name">{item.name}</span>
        <PriceLabel currency={currency} item={item} />
        {/* Only when the restaurant has switched guest ordering on; otherwise the menu is as it was. */}
        {onAdd && !item.variants && (
          <button type="button" className="add" onClick={() => onAdd(item)} aria-label={`Add ${item.name}`}>+</button>
        )}
      </div>

      {item.variants && (
        <ul className="variants">
          {item.variants.map(v => (
            <li key={v.id}>
              <span>{v.label}</span>
              <span className="variant-price">{money(currency, v.price)}</span>
              {onAdd && (
                <button type="button" className="add" onClick={() => onAdd(item, v)} aria-label={`Add ${item.name}, ${v.label}`}>+</button>
              )}
            </li>
          ))}
        </ul>
      )}

      {item.options && item.options.map(group => (
        <p className="options" key={group.id}>
          <span className="group-label">{group.label}:</span>{' '}
          {group.options.map((o, i) => (
            <React.Fragment key={o.id}>
              {i > 0 && ', '}
              {o.label}{o.price_delta > 0 ? ` +${money(currency, o.price_delta)}` : ''}
            </React.Fragment>
          ))}
        </p>
      ))}
    </li>
  );
}

export function DinerMenu() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // Whether this restaurant lets guests order from the table code. Off unless it says otherwise,
  // so a hub that cannot answer shows the menu it always did rather than a basket that fails.
  const [ordering, setOrdering] = useState(false);
  const [basket, setBasket] = useState({});

  // Carried from the QR on the table, shown so a guest can tell they scanned their own code. The
  // menu does not depend on it. Feedback does send it: the hub uses it to find that table's most
  // recently settled bill, so it is guest-supplied input there and the hub treats it as such
  // (a per-table cooldown, and a bill it resolves itself rather than one the guest names).
  const table = new URLSearchParams(window.location.search).get('t');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/public/menu', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
      setError(null);
    } catch {
      setError('menu');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let live = true;
    fetch('/public/ordering', { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : null))
      .then(body => { if (live && body?.ordering && table) setOrdering(true); })
      .catch(() => { /* the menu is the point; a basket is the extra */ });
    return () => { live = false; };
  }, [table]);

  const addItem = (item, variant) => setBasket(b => addToBasket(b, item, variant));
  // The basket's own + button hands back ids rather than the item, so it is matched here.
  const addByIds = (itemId, variantId) => setBasket(b => {
    for (const category of data?.categories ?? []) {
      const item = category.items.find(i => String(i.id) === String(itemId));
      if (!item) continue;
      return addToBasket(b, item, variantId ? (item.variants ?? []).find(v => String(v.id) === String(variantId)) : undefined);
    }
    return b;
  });

  if (error) {
    return (
      <main className="wrap">
        <p className="muted">The menu could not be loaded. Please ask a member of staff.</p>
        <button type="button" className="retry" onClick={load}>Try again</button>
      </main>
    );
  }

  if (!data) return <main className="wrap"><p className="muted">Loading the menu…</p></main>;

  const currency = data.restaurant?.currency || '₹';

  return (
    <main className="wrap">
      <header className="head">
        <h1>{data.restaurant?.name}</h1>
        {table && <p className="muted">Table {table}</p>}
      </header>

      {data.categories.length === 0 && <p className="muted">Nothing is being served right now.</p>}

      {data.categories.map(cat => (
        <section key={cat.name}>
          <h2>{cat.name}</h2>
          <ul className="items">
            {cat.items.map(item => <Item key={item.id} currency={currency} item={item} onAdd={ordering ? addItem : undefined} />)}
          </ul>
        </section>
      ))}

      {ordering && (
        <Basket
          basket={basket}
          currency={currency}
          table={table}
          onAdd={addByIds}
          onRemove={key => setBasket(b => removeFromBasket(b, key))}
          onSent={() => setBasket({})}
        />
      )}

      {/* After the menu, not before it: a guest reading the menu has not eaten yet. */}
      <Feedback table={table} />

      <footer className="foot">
        <p className="muted">
          {ordering
            ? 'Prices include all taxes shown on your bill. A member of staff will bring your order over.'
            : 'Prices include all taxes shown on your bill. To order, please ask a member of staff.'}
        </p>
      </footer>
    </main>
  );
}
