import React, { useCallback, useEffect, useState } from 'react';

import { Feedback } from './Feedback';

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

function Item({ currency, item }) {
  return (
    <li className="item">
      <div className="item-head">
        <span className={item.is_veg ? 'dot veg' : 'dot nonveg'} aria-hidden="true" />
        <span className="item-name">{item.name}</span>
        <PriceLabel currency={currency} item={item} />
      </div>

      {item.variants && (
        <ul className="variants">
          {item.variants.map(v => (
            <li key={v.id}>
              <span>{v.label}</span>
              <span className="variant-price">{money(currency, v.price)}</span>
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
            {cat.items.map(item => <Item key={item.id} currency={currency} item={item} />)}
          </ul>
        </section>
      ))}

      {/* After the menu, not before it: a guest reading the menu has not eaten yet. */}
      <Feedback table={table} />

      <footer className="foot">
        <p className="muted">Prices include all taxes shown on your bill. To order, please ask a member of staff.</p>
      </footer>
    </main>
  );
}
