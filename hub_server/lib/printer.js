import net from 'net';
import * as escpos from './escpos.js';

/**
 * Receipt + KOT rendering, and TCP transport.
 *
 * The two `render*` functions are pure and return
 *   { escpos: Buffer, preview_text: string }
 * so tests can assert on preview_text without hardware, and the UI can show
 * reception exactly what the printer will emit before it hits paper.
 *
 * `sendToPrinter({ escpos }, target)` opens raw TCP to `host:port` (default
 * 9100, standard for thermal printers), writes the bytes, and closes. Both
 * connect and write time out at 4 s so a stuck printer never blocks the
 * hub. Missing / unreachable printers surface as `{ ok: false, ... }`; the
 * caller decides whether to fail the request or swallow the failure.
 */

// Standard 80mm thermal is ~42 chars in the default font. All the layout
// numbers below (rules, column widths) are derived from this.
const RECEIPT_WIDTH = 42;
const KOT_WIDTH = 42;

function padLeft(s, width)  { s = String(s); return s.length >= width ? s : ' '.repeat(width - s.length) + s; }
function padRight(s, width) { s = String(s); return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length); }
function center(s, width)   {
  s = String(s);
  if (s.length >= width) return s.slice(0, width);
  const pad = Math.floor((width - s.length) / 2);
  return ' '.repeat(pad) + s + ' '.repeat(width - s.length - pad);
}

function formatDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (!Number.isFinite(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function line(width, ch) { return ch.repeat(width); }

// ---------------------------------------------------------------------------
// Kitchen Order Ticket (KOT)
// ---------------------------------------------------------------------------

export function renderKot(ticket, tenant = {}, opts = {}) {
  if (!ticket || !Array.isArray(ticket.items)) {
    throw new Error('renderKot requires a ticket with items[]');
  }
  const width = KOT_WIDTH;
  // Optional station label (M2 · PR 15): when a ticket is split across
  // stations we render one KOT per station, each carrying its own header
  // suffix ("KITCHEN ORDER · BAR") so the cook can eyeball at a glance
  // where the ticket belongs. Legacy single-KOT callers pass no opts and
  // the header stays exactly as before.
  const stationLabel = opts && opts.station_label ? String(opts.station_label) : '';
  const headerText = stationLabel
    ? `KITCHEN ORDER · ${stationLabel.toUpperCase()}`
    : 'KITCHEN ORDER TICKET';
  const header = center(headerText, width);
  const table  = center(`${ticket.table_name || 'Table'}   ·   #${ticket.ticket_number ?? ''}`, width);
  const when   = center(formatDate(ticket.created_at || Date.now()), width);
  const by     = center(`By: ${ticket.created_by_waiter || 'Waiter'}`, width);

  // KOT modifier rendering (M2 · PR 12): options list under the item, two-
  // space indent so the kitchen scans qty/name at the left margin and picks
  // up modifiers as sub-lines. Zero-delta modifiers are prep instructions
  // ("Spice: Hot", "No onion") and don't print a price; positive deltas do
  // ("+ Extra cheese +₹40"). The kitchen doesn't need money for prep, but
  // seeing the +₹ helps when a substitution is challenged.
  const modLine = (m) => {
    const label = String(m?.option_label || '');
    const delta = Number(m?.price_delta) || 0;
    if (delta > 0) return `  + ${label} +₹${delta}`;
    if (delta < 0) return `  + ${label} -₹${Math.abs(delta)}`;
    // Group label helps the kitchen distinguish "Spice: Hot" from a bare "Hot".
    const group = m?.group_label ? `${m.group_label}: ` : '';
    return `  · ${group}${label}`;
  };
  const itemLines = ticket.items.flatMap(i => {
    const qty = Number(i?.qty) || 0;
    const name = String(i?.name || '');
    const variant = i?.variant_label ? ` (${i.variant_label})` : '';
    // Day-part attribution (M2 · PR 13): a "· Happy hour" suffix so the
    // kitchen sees which promotion the line was billed at. Prep-time
    // decisions (portion size, sides) don't change, but a challenged
    // receipt can be reconciled straight from the KOT.
    const dayPart = i?.day_part_label ? ` · ${i.day_part_label}` : '';
    const head = `${qty}x ${name}${variant}${dayPart}`;
    const mods = Array.isArray(i?.modifiers) ? i.modifiers.map(modLine) : [];
    return [head, ...mods];
  });

  const noteLines = ticket.note
    ? [line(width, '-'), `Note: ${ticket.note}`]
    : [];

  const preview_lines = [
    line(width, '='),
    header,
    line(width, '='),
    table,
    when,
    by,
    line(width, '-'),
    ...itemLines,
    ...noteLines,
    ''
  ];
  const preview_text = preview_lines.join('\n');

  const escposBuf = escpos.build(
    escpos.init(),
    escpos.alignCenter(),
    escpos.rule(width, '='),
    escpos.bold(true), escpos.size(2, 2),
    escpos.line(headerText),
    escpos.size(1, 1), escpos.bold(false),
    escpos.rule(width, '='),
    escpos.bold(true), escpos.size(2, 1),
    escpos.line(`${ticket.table_name || 'Table'}  #${ticket.ticket_number ?? ''}`),
    escpos.size(1, 1), escpos.bold(false),
    escpos.line(formatDate(ticket.created_at || Date.now())),
    escpos.line(`By: ${ticket.created_by_waiter || 'Waiter'}`),
    escpos.alignLeft(),
    escpos.rule(width, '-'),
    escpos.bold(true),
    ...itemLines.map(l => escpos.line(l)),
    escpos.bold(false),
    ...(ticket.note ? [escpos.rule(width, '-'), escpos.line(`Note: ${ticket.note}`)] : []),
    escpos.feed(3),
    escpos.cut()
  );

  return { escpos: escposBuf, preview_text };
}

// ---------------------------------------------------------------------------
// Customer receipt
// ---------------------------------------------------------------------------

export function renderReceipt(invoice, tenant = {}) {
  if (!invoice || !Array.isArray(invoice.items)) {
    throw new Error('renderReceipt requires an invoice with items[]');
  }
  const width = RECEIPT_WIDTH;
  const currency = invoice.currency || '₹';
  const name = tenant.name || 'Restaurant';
  const city = tenant.city ? [center(tenant.city, width)] : [];
  const phone = tenant.phone ? [center(`Ph: ${tenant.phone}`, width)] : [];

  const invHeader = center(`${invoice.invoice_number || 'PREVIEW'}`, width);
  const tableLine = center(`${invoice.table_name || ''} · ${formatDate(invoice.issued_at || Date.now())}`, width);

  // Layout: qty (3) + name (23) + total (padLeft 8) + gap columns
  // "Item".padRight(20) + "Qty".padLeft(4) + "Price".padLeft(8) + "Total".padLeft(9)
  const colHeader = padRight('Item', 20) + padLeft('Qty', 4) + padLeft('Price', 8) + padLeft('Total', 9);
  // Receipt modifier rendering (M2 · PR 12): under each item, one sub-line
  // per modifier — same 20-char left column, no qty/price for zero-delta
  // "prep" modifiers (they inform the kitchen, not the customer), a right-
  // aligned delta column for paid modifiers so the customer can reconcile.
  // The head-line `price` and `line_total` already include modifier deltas
  // (the hub applies them per-unit in pricing.js), so we don't double-count
  // by summing deltas here — this block is display only.
  const itemLines = invoice.items.flatMap(l => {
    const base = String(l.name || '');
    const variantSuffix = l.variant_label ? ` — ${l.variant_label}` : '';
    const nm = (base + variantSuffix).slice(0, 20);
    const head = padRight(nm, 20)
      + padLeft(String(l.qty), 4)
      + padLeft(String(l.price), 8)
      + padLeft(String(l.line_total), 9);
    // Day-part sub-line (M2 · PR 13). Zero-width numeric columns since the
    // window's price is already reflected in `l.price`; the sub-line just
    // annotates WHY that number is what it is, so a challenged bill can
    // reference "Happy hour" without a receipt reprint.
    const dayPartLine = l.day_part_label
      ? [padRight(`  · ${l.day_part_label}`.slice(0, width), width)]
      : [];
    const mods = Array.isArray(l.modifiers) ? l.modifiers : [];
    const modLines = mods.map(m => {
      const label = String(m?.option_label || '');
      const delta = Number(m?.price_delta) || 0;
      if (delta === 0) {
        // "  · Spice: Hot" style, spans the whole width, no numeric columns.
        const group = m?.group_label ? `${m.group_label}: ` : '';
        return padRight(`  · ${group}${label}`.slice(0, width), width);
      }
      const sign = delta > 0 ? '+' : '−';
      const amt = `${sign}₹${Math.abs(delta)}`;
      return padRight(`  + ${label}`.slice(0, 20), 20)
        + padLeft('', 4)
        + padLeft('', 8)
        + padLeft(amt, 9);
    });
    return [head, ...dayPartLine, ...modLines];
  });

  function summaryRow(label, amount) {
    // Right-align label + amount inside `width`. Amount padded to 10 chars.
    const amountText = `${currency}${amount}`;
    const labelText  = `${label}  `;
    const pad = Math.max(0, width - labelText.length - amountText.length);
    return ' '.repeat(pad) + labelText + amountText;
  }

  const summaryLines = [summaryRow('Subtotal', invoice.subtotal)];
  if (Array.isArray(invoice.discount_rows)) {
    for (const r of invoice.discount_rows) {
      const label = `Discount${r.type === 'percent' ? ` (${r.value}%)` : ''}${r.reason ? ` · ${r.reason}` : ''}`;
      summaryLines.push(summaryRow(label, `-${r.amount}`));
    }
  }
  if (Number(invoice.service_charge_amount) > 0) {
    summaryLines.push(summaryRow(`Service charge (${invoice.service_charge_percent}%)`, invoice.service_charge_amount));
  }
  for (const r of (invoice.tax_rows || [])) {
    summaryLines.push(summaryRow(`${r.label} (${r.rate_percent}%)`, r.amount));
  }

  const footer = [];
  if (invoice.payment_status === 'paid') {
    const method = String(invoice.payment_method || '').toUpperCase();
    footer.push(center(`Paid: ${method}${invoice.payment_ref ? ` · Ref: ${invoice.payment_ref}` : ''}`, width));
  } else if (invoice.payment_status === 'pending') {
    footer.push(center('*** UNPAID — NOT A RECEIPT ***', width));
  } else if (invoice.payment_status === 'refunded') {
    footer.push(center('*** REFUNDED ***', width));
  }
  footer.push(center('Thank you for dining with us', width));

  const preview_lines = [
    line(width, '='),
    center(name, width),
    ...city,
    ...phone,
    invHeader,
    tableLine,
    line(width, '='),
    colHeader,
    line(width, '-'),
    ...itemLines,
    line(width, '-'),
    ...summaryLines,
    line(width, '='),
    summaryRow('GRAND TOTAL', invoice.grand_total),
    line(width, '='),
    ...footer,
    ''
  ];
  const preview_text = preview_lines.join('\n');

  const escposBuf = escpos.build(
    escpos.init(),
    escpos.alignCenter(),
    escpos.bold(true), escpos.size(2, 2), escpos.line(name),
    escpos.size(1, 1), escpos.bold(false),
    ...(tenant.city ? [escpos.line(tenant.city)] : []),
    ...(tenant.phone ? [escpos.line(`Ph: ${tenant.phone}`)] : []),
    escpos.line(invoice.invoice_number || 'PREVIEW'),
    escpos.line(`${invoice.table_name || ''} · ${formatDate(invoice.issued_at || Date.now())}`),
    escpos.rule(width, '='),
    escpos.alignLeft(),
    escpos.line(colHeader),
    escpos.rule(width, '-'),
    ...itemLines.map(l => escpos.line(l)),
    escpos.rule(width, '-'),
    ...summaryLines.map(l => escpos.line(l)),
    escpos.rule(width, '='),
    escpos.bold(true), escpos.size(1, 2),
    escpos.line(summaryRow('GRAND TOTAL', invoice.grand_total)),
    escpos.size(1, 1), escpos.bold(false),
    escpos.rule(width, '='),
    escpos.alignCenter(),
    ...footer.map(l => escpos.line(l)),
    escpos.feed(3),
    escpos.cut()
  );

  return { escpos: escposBuf, preview_text };
}

// ---------------------------------------------------------------------------
// TCP transport
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 4000;
const WRITE_TIMEOUT_MS   = 4000;

/**
 * Send a rendered job to a printer target.
 *
 * `target`:
 *   - `{ mode: 'preview' }` — never dials out; returns `{ ok: true, preview: true }`.
 *   - `{ host, port? }`     — raw TCP to `host:port` (default 9100).
 *
 * Fail-soft on network errors — returns `{ ok: false, error, code }`;
 * caller decides whether that should be a 500 or an ignored best-effort.
 */
export function sendToPrinter(job, target = { mode: 'preview' }) {
  if (!job || !Buffer.isBuffer(job.escpos)) {
    return Promise.resolve({ ok: false, error: 'renderer produced no bytes', code: 'INVALID_JOB' });
  }
  if (!target || target.mode === 'preview' || !target.host) {
    return Promise.resolve({ ok: true, preview: true, sent_bytes: 0 });
  }

  const host = String(target.host);
  const port = Number(target.port) || 9100;

  return new Promise(resolve => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    };

    const socket = net.createConnection({ host, port });
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      socket.setTimeout(WRITE_TIMEOUT_MS);
      socket.write(job.escpos, (err) => {
        if (err) return done({ ok: false, error: err.message, code: 'WRITE_FAILED' });
        // Give the printer half a beat to flush before we tear down.
        setTimeout(() => done({ ok: true, preview: false, sent_bytes: job.escpos.length }), 100);
      });
    });

    socket.once('error', (err) => done({ ok: false, error: err.message, code: 'CONNECT_FAILED' }));
    socket.once('timeout', () => done({ ok: false, error: `Printer ${host}:${port} timed out`, code: 'TIMEOUT' }));
  });
}
