// Pushes the hub's menu and table layout to the cloud (Supabase). The hub is the single writer: each
// push is a full snapshot, upserted on (restaurant_id, hub_ref) and followed by deleting the cloud rows
// the snapshot no longer holds. Upserts run before deletes, so an interrupted push never loses a row.
//
// `client` is a supabase-js client; it is a parameter so tests can hand in a recording fake.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 100;

export const isUuid = value => typeof value === 'string' && UUID.test(value);

const chunks = (list, size = CHUNK) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

export function categoryRow(restaurantId, name, index) {
  return { restaurant_id: restaurantId, hub_ref: String(name), name: String(name), display_order: index };
}

export function menuItemRow(restaurantId, item) {
  return {
    restaurant_id: restaurantId,
    hub_ref: String(item.id),
    category_name: item.category,
    name: item.name,
    price: Number(item.price) || 0,
    is_veg: item.isVeg !== false,
    available: item.available !== false,
    // Explicit empties, not omitted keys: dropping the last variant must clear it in the cloud too.
    variants: Array.isArray(item.variants) ? item.variants : [],
    modifier_groups: Array.isArray(item.modifier_groups) ? item.modifier_groups : [],
    day_parts: Array.isArray(item.day_parts) ? item.day_parts : [],
    station: item.station || null
  };
}

export function tableRow(restaurantId, table, index) {
  return {
    restaurant_id: restaurantId,
    hub_ref: String(table.id),
    name: table.name,
    section: table.section,
    capacity: Number(table.capacity) || 1,
    // The pull orders by this column, which is how a replacement hub recovers the layout order.
    display_order: index
  };
}

// ---- Recovery: cloud rows -> hub cache shapes (a replacement laptop rebuilds from these) ----

// The id a cloud table row has on the hub: the hub's own id (hub_ref) when it pushed the row, otherwise the
// cloud id. Hub-made tables have small integer ids, which come back from the text column as numbers again.
const tableIdOf = row => {
  const ref = row.hub_ref;
  if (ref === undefined || ref === null || ref === '') return row.id;
  return /^\d{1,9}$/.test(String(ref)) ? Number(ref) : String(ref);
};

/** `rows` arrive ordered by display_order, which is the layout order the hub pushed. */
export function tablesFromCloud(rows) {
  return rows.map((t, idx) => ({
    id: tableIdOf(t) || (idx + 1),
    name: t.name || `T${idx + 1}`,
    section: t.section || 'Main Dining',
    capacity: Number(t.capacity) || 4
  }));
}

// Throws the Supabase error so the queue can tell a hub-wide refusal from a bad snapshot.
const check = ({ error }) => {
  if (error) throw error;
};

export async function upsertAll(client, table, rows) {
  for (const part of chunks(rows)) {
    check(await client.from(table).upsert(part, { onConflict: 'restaurant_id,hub_ref' }));
  }
}

export async function deleteStale(client, table, restaurantId, keep) {
  const res = await client.from(table).select('id, hub_ref').eq('restaurant_id', restaurantId);
  check(res);
  const stale = (res.data || []).filter(row => !row.hub_ref || !keep.has(row.hub_ref)).map(row => row.id);
  for (const part of chunks(stale)) {
    check(await client.from(table).delete().eq('restaurant_id', restaurantId).in('id', part));
  }
  return stale.length;
}

/** Pushes `{ categories: string[], items: [] }` for one restaurant. */
export async function pushMenu(client, restaurantId, menu) {
  const categories = (menu.categories || []).map((name, i) => categoryRow(restaurantId, name, i));
  const items = (menu.items || []).map(item => menuItemRow(restaurantId, item));

  await upsertAll(client, 'menu_categories', categories);
  await upsertAll(client, 'menu_items', items);
  const removedItems = await deleteStale(client, 'menu_items', restaurantId, new Set(items.map(r => r.hub_ref)));
  const removedCategories = await deleteStale(client, 'menu_categories', restaurantId, new Set(categories.map(r => r.hub_ref)));
  return { categories: categories.length, items: items.length, removed: removedItems + removedCategories };
}

/** Pushes `{ tables: [] }` for one restaurant. */
export async function pushTables(client, restaurantId, layout) {
  const tables = (layout.tables || []).map((table, i) => tableRow(restaurantId, table, i));

  await upsertAll(client, 'tables', tables);
  const removed = await deleteStale(client, 'tables', restaurantId, new Set(tables.map(r => r.hub_ref)));
  return { tables: tables.length, removed };
}
