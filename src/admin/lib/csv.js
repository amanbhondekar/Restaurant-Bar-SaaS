// CSV helpers for the menu import file. Plain ESM with no DOM and no React, so the hub's
// `node --test` suite can exercise them. The browser parses an uploaded .csv/.xlsx into plain
// string rows (the hub never sees the file); the same format is written back out by menuToCsv,
// so the export doubles as the template and as a backup.

/** The columns the hub's importer understands, in the order the export writes them. */
export const MENU_COLUMNS = ['id', 'name', 'category', 'price', 'veg', 'available', 'station', 'course', 'variants'];

// Mirrors STATIONS in hub_server/lib/menuAdmin.js (the importer refuses anything else).
const STATIONS = ['hot', 'cold', 'bar'];

/**
 * RFC 4180 reader: quoted fields, "" for a quote inside one, commas and line breaks inside quotes,
 * CRLF / LF / lone CR record separators, an optional UTF-8 BOM. A blank line is a record with one
 * empty field (so row numbers still match the file); the final newline does not add a record.
 * Stray quotes are tolerated rather than rejected: a quote inside an unquoted field is literal, text
 * after a closing quote is kept, and an unterminated quote runs to the end of the file.
 * @returns {string[][]}
 */
export function parseCsv(text) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  let fieldStart = true; // nothing of the current field has been read yet

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch !== '"') field += ch;
      else if (s[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = false;
    } else if (ch === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
    } else if (ch === ',') {
      record.push(field);
      field = '';
      fieldStart = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      fieldStart = true;
    } else {
      field += ch;
      fieldStart = false;
    }
  }
  if (!fieldStart || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

// Spreadsheet readers hand back numbers, booleans and nulls; the importer wants trimmed strings.
const cellText = v => (v === null || v === undefined ? '' : String(v).trim());
const isBlankRow = cells => cells.every(c => c === '');

/**
 * Turns a table of cells (from parseCsv, or from an .xlsx reader) into importer rows.
 * The first non-empty row is the header. Keys are lower-cased and trimmed, every cell is a trimmed
 * string, fully empty rows are dropped, and each row gets `__row`: its 1-based row number in the
 * spreadsheet, so dropping blank rows does not shift the numbers shown in the review. A repeated
 * header keeps its first column and an unnamed column is ignored.
 * @returns {{ rows: Array<Record<string, string|number>>, columns: string[] }}
 */
export function rowsFromTable(table) {
  const lines = (Array.isArray(table) ? table : []).map(line => (Array.isArray(line) ? line : []).map(cellText));
  const headerAt = lines.findIndex(cells => !isBlankRow(cells));
  if (headerAt === -1) return { rows: [], columns: [] };

  const columns = [];
  const keyAt = lines[headerAt].map(cell => {
    const key = cell.toLowerCase();
    if (!key || columns.includes(key)) return null;
    columns.push(key);
    return key;
  });

  const rows = [];
  for (let i = headerAt + 1; i < lines.length; i++) {
    const cells = lines[i];
    if (isBlankRow(cells)) continue;
    const row = {};
    keyAt.forEach((key, j) => {
      if (key !== null) row[key] = cells[j] ?? '';
    });
    row.__row = i + 1;
    rows.push(row);
  }
  return { rows, columns };
}

/** Reads CSV text the way the importer expects it: `{ rows, columns }` as rowsFromTable. */
export function csvToRows(text) {
  return rowsFromTable(parseCsv(text));
}

const csvField = value => {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// A price the importer would accept; anything else is left blank (a blank cell never overwrites).
const priceCell = n => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? String(n) : '');

/**
 * The current menu as a CSV file: a header and one row per item, in the importer's format, so that
 * importing it back reports every row unchanged. veg / available are yes / no, station is blank
 * unless it is hot, cold or bar, variants are `Label:price|Label:price`. Modifier groups and
 * day-parts are not part of the file (the importer leaves them alone). Starts with a UTF-8 BOM so
 * Excel shows the rupee sign correctly; lines end in CRLF.
 */
export function menuToCsv(menu) {
  const items = Array.isArray(menu?.items) ? menu.items : [];
  const lines = [MENU_COLUMNS.join(',')];
  for (const item of items) {
    const station = String(item.station ?? '').toLowerCase();
    const variants = Array.isArray(item.variants) ? item.variants.map(v => `${v.label}:${v.price}`).join('|') : '';
    lines.push([
      item.id,
      item.name,
      item.category,
      priceCell(item.price),
      item.isVeg === false ? 'no' : 'yes',
      item.available === false ? 'no' : 'yes',
      STATIONS.includes(station) ? station : '',
      // Blank means the default (course 1), matching what the editor shows and what a blank
      // cell means to the importer: leave it alone.
      Number.isInteger(item.course) && item.course >= 1 && item.course <= 9 ? String(item.course) : '',
      variants
    ].map(csvField).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
