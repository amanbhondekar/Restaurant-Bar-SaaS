// The admin console's tabs, and which one a link asks for. A link such as /admin#sales (the old reception shell
// uses them) opens that tab instead of the default; anything it does not recognise is ignored rather than
// trusted, so a mistyped or hostile fragment can only ever land on the default.

export const TAB_IDS = ['menu', 'tables', 'bookings', 'cash', 'sales', 'stock', 'kitchen', 'printers', 'staff', 'feedback', 'plan'];

export const DEFAULT_TAB = 'menu';

/** The tab named by a location hash ("#sales"), or the default. */
export function tabFromHash(hash) {
  const id = String(hash ?? '').replace(/^#/, '').toLowerCase();
  return TAB_IDS.includes(id) ? id : DEFAULT_TAB;
}
