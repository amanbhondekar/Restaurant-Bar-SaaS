import React, { useState } from 'react';

// Feedback after a meal (M4 · 4.5), on the page the guest already has open from the code on
// their table. Deliberately one tap and done: a guest doing this is usually standing up to leave.

const STARS = [1, 2, 3, 4, 5];
const MAX_COMMENT = 500;

export function Feedback({ table }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [state, setState] = useState('idle'); // idle | sending | done | error
  const [message, setMessage] = useState(null);

  const submit = async event => {
    event.preventDefault();
    if (!rating || state === 'sending') return;
    setState('sending');
    try {
      const res = await fetch('/public/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table, rating, comment })
      });
      if (res.ok) {
        setState('done');
        return;
      }
      const body = await res.json().catch(() => ({}));
      // A table that has already been heard from is not an error the guest should feel bad about.
      if (body.code === 'ALREADY_SUBMITTED') {
        setState('done');
        return;
      }
      setMessage(body.error || 'That could not be sent.');
      setState('error');
    } catch {
      setMessage('That could not be sent. You may be off the restaurant\'s wifi.');
      setState('error');
    }
  };

  if (state === 'done') {
    return (
      <section className="feedback" aria-live="polite">
        <h2>Thank you</h2>
        <p className="muted">Your feedback has gone straight to the staff here.</p>
      </section>
    );
  }

  return (
    <section className="feedback">
      <h2>How was your meal?</h2>
      <form onSubmit={submit}>
        <fieldset className="stars">
          <legend className="sr-only">Rating out of five</legend>
          {STARS.map(n => (
            <button
              key={n}
              type="button"
              className={n <= rating ? 'star on' : 'star'}
              aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`}
              aria-pressed={n <= rating}
              onClick={() => setRating(n)}
            >
              ★
            </button>
          ))}
        </fieldset>

        <label className="sr-only" htmlFor="fb-comment">Anything you would like to add</label>
        <textarea
          id="fb-comment"
          placeholder="Anything you would like to add? (optional)"
          maxLength={MAX_COMMENT}
          rows={3}
          value={comment}
          onChange={e => setComment(e.target.value)}
        />

        {state === 'error' && <p className="error" role="alert">{message}</p>}

        <button type="submit" className="send" disabled={!rating || state === 'sending'}>
          {state === 'sending' ? 'Sending…' : 'Send feedback'}
        </button>
      </form>
    </section>
  );
}
