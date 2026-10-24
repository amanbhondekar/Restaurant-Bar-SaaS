import React, { useState } from 'react';

import { basketCount, basketLines, basketTotal, basketToOrder, money } from './lib/basket';

// The basket a guest sends to the kitchen (§4.5).
//
// Deliberately modest about what it claims. It shows what the dishes come to as the menu adds them
// up, labelled "about", because tax and any service charge are worked out by the hub when the bill is
// raised -- a total presented as final here is one the guest would then be charged more than.
//
// There is no payment on this screen. Paying from a phone needs a payment provider configured, which
// is a separate slice; until then the bill is settled with a member of staff exactly as it always was.

export function Basket({ basket, currency, table, onAdd, onRemove, onSent }) {
  const [state, setState] = useState('idle');   // idle | sending | sent | error
  const [message, setMessage] = useState(null);
  const [ticket, setTicket] = useState(null);

  const lines = basketLines(basket);
  const count = basketCount(basket);

  const send = async () => {
    setState('sending');
    setMessage(null);
    try {
      const res = await fetch('/public/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table, items: basketToOrder(basket) })
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setTicket(body.ticket_number ?? null);
        setState('sent');
        onSent?.();
        return;
      }
      setMessage(body.error || 'That could not be sent. Please ask a member of staff.');
      setState('error');
    } catch {
      setMessage('That could not be sent. You may be off the restaurant\'s wifi.');
      setState('error');
    }
  };

  if (state === 'sent') {
    return (
      <section className="basket" aria-live="polite">
        <h2>Sent to the kitchen</h2>
        <p className="muted">
          {ticket ? `Your order is number ${ticket}. ` : ''}A member of staff will bring it over, and you can settle up with them.
        </p>
      </section>
    );
  }

  if (count === 0) return null;

  return (
    <section className="basket" aria-label="Your order">
      <h2>Your order</h2>
      <ul className="basket-lines">
        {lines.map(line => (
          <li key={line.key}>
            <span className="basket-name">
              {line.name}{line.variant_label ? <span className="muted"> · {line.variant_label}</span> : null}
            </span>
            <span className="basket-qty">
              <button type="button" onClick={() => onRemove(line.key)} aria-label={`One fewer ${line.name}`}>−</button>
              <span aria-label={`${line.qty} ${line.name}`}>{line.qty}</span>
              <button type="button" onClick={() => onAdd(line.item_id, line.variant_id)} aria-label={`One more ${line.name}`}>+</button>
            </span>
            <span className="basket-price">{money(currency, line.price * line.qty)}</span>
          </li>
        ))}
      </ul>

      <p className="basket-total">
        <span>About</span>
        <strong>{money(currency, basketTotal(basket))}</strong>
      </p>
      <p className="muted basket-caveat">
        Tax and any service charge are added to your bill, so the total on it may differ.
      </p>

      {state === 'error' && <p className="error" role="alert">{message}</p>}

      <button type="button" className="send" onClick={send} disabled={state === 'sending'}>
        {state === 'sending' ? 'Sending…' : `Send ${count} item${count === 1 ? '' : 's'} to the kitchen`}
      </button>
      <p className="muted basket-caveat">You pay a member of staff at the end, as usual.</p>
    </section>
  );
}
