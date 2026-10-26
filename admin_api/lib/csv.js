// The audit log as a file (P1-5). A cell a spreadsheet would run as a formula (one that starts with = + - @ or a control character) is written
// with a leading apostrophe, so a restaurant's name or a payload cannot become an instruction on a founder's laptop.

const FORMULA = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

function cell(value) {
  if (value === null || value === undefined) return '';
  let text;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  if (FORMULA.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** `columns` is a list of [key, header]; only those keys are written, so a column added to the data later does not reach the file. */
export function toCsv(columns, rows) {
  const lines = [columns.map(([, header]) => cell(header)).join(',')];
  for (const row of rows) lines.push(columns.map(([key]) => cell(row[key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
