/**
 * Minimal ESC/POS encoder.
 *
 * We ship the small handful of commands the receipt + KOT layouts need
 * inline rather than pulling in the ~1MB `escpos` package with its native
 * USB deps. Everything downstream operates on `Buffer`s and concatenates
 * with `Buffer.concat`.
 *
 * Character set: printers default to CP437, which is safe for ASCII but
 * lacks ₹. We normalise strings to a printer-safe encoding by rewriting
 * unsupported characters (₹ → "Rs ") before conversion to latin-1 bytes.
 * If a tenant runs a printer with a different codepage, the mapping is a
 * single place to change.
 */

const ESC = 0x1B;
const GS  = 0x1D;

function b(...bytes) {
  return Buffer.from(bytes);
}

// Init: reset formatting, clear buffer.
export function init() { return b(ESC, 0x40); }

// Line-feed(s).
export function feed(n = 1) { return b(ESC, 0x64, Math.max(0, Math.min(255, n | 0))); }

// Full paper cut.
export function cut() { return b(GS, 0x56, 0x00); }

// Alignment: 0 = left, 1 = center, 2 = right.
export function align(mode) { return b(ESC, 0x61, mode & 3); }
export const alignLeft   = () => align(0);
export const alignCenter = () => align(1);
export const alignRight  = () => align(2);

// Bold.
export function bold(on)  { return b(ESC, 0x45, on ? 1 : 0); }

// Character size: multiplier 1..8 for width and height, packed into one byte.
export function size(widthMul = 1, heightMul = 1) {
  const w = Math.max(1, Math.min(8, widthMul)) - 1;
  const h = Math.max(1, Math.min(8, heightMul)) - 1;
  return b(GS, 0x21, (w << 4) | h);
}

/**
 * Rewrite characters common to Indian receipts that CP437 lacks. We keep the
 * table tight — a real printer with a swapped codepage can bypass this by
 * setting `raw: true` on writeText().
 */
const CHAR_MAP = {
  '₹': 'Rs ',  // ₹  Indian Rupee sign
  '–': '-',    // – en dash
  '—': '-',    // — em dash
  '‘': "'",    // ‘
  '’': "'",    // ’
  '“': '"',    // “
  '”': '"',    // ”
  '…': '...',  // …
  ' ': ' ',    // no-break space
  '✅': '',     // ✓ discard rather than fill with ?
  '✖': '',     // ✖
  '↩': '',     // ↩
};

export function sanitiseForPrinter(s) {
  if (s == null) return '';
  const str = String(s);
  return str.replace(/[ –—‘’“”…₹✅✖↩]/g,
    ch => (CHAR_MAP[ch] ?? '?'));
}

export function text(s, opts = {}) {
  const cleaned = opts.raw ? String(s ?? '') : sanitiseForPrinter(s);
  // 'binary' encoding treats each JS code point < 256 as a single byte,
  // which is what CP437 expects for the ASCII subset we're using.
  return Buffer.from(cleaned, 'binary');
}

export function line(s = '') {
  return Buffer.concat([text(s), b(0x0A)]); // 0x0A = LF, printer advances one line
}

/** Handy for `-------` / `======` full-width rules. */
export function rule(width, char = '-') {
  return line(char.repeat(width));
}

/**
 * Concatenate commands + text into one Buffer, in order. Works with strings
 * (converted to text automatically) OR pre-built Buffers.
 */
export function build(...parts) {
  const buffers = parts.flat().map(p =>
    Buffer.isBuffer(p) ? p : text(String(p))
  );
  return Buffer.concat(buffers);
}
