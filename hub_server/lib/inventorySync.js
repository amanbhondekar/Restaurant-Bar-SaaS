import { upsertAll, deleteStale } from './catalogSync.js';
import { cleanLine } from './inventory.js';

// Pushes the hub's stock and recipes to the cloud (migration 009), and reads them back for a
// replacement hub. Same arrangement as the menu and tables: the hub is the single writer, each push
// is a full snapshot upserted on (restaurant_id, hub_ref) and followed by deleting the rows the
// snapshot no longer holds.
//
// `client` is a supabase-js client; it is a parameter so tests can hand in a recording fake.

export function inventoryItemRow(restaurantId, item) {
  return {
    restaurant_id: restaurantId,
    hub_ref: String(item.id),
    name: item.name,
    unit: item.unit,
    on_hand: Number(item.on_hand) || 0,
    low_at: Number(item.low_at) || 0
  };
}

export function recipeRow(restaurantId, recipe) {
  return {
    restaurant_id: restaurantId,
    hub_ref: String(recipe.id),
    menu_item_ref: String(recipe.item_id),
    // Explicit null for the dish-wide recipe, not an omitted key: the upsert must be able to clear it.
    variant_ref: recipe.variant_id == null ? null : String(recipe.variant_id),
    lines: (recipe.lines || []).map(cleanLine).filter(Boolean)
  };
}

/** Pushes `{ items, recipes }` for one restaurant. Resolves to counts; throws the Supabase error. */
export async function pushInventory(client, restaurantId, snapshot) {
  const items = (snapshot.items || []).map(i => inventoryItemRow(restaurantId, i));
  const recipes = (snapshot.recipes || []).map(r => recipeRow(restaurantId, r));

  // Upserts before deletes, so an interrupted push never loses a row. Ingredients go first: a recipe
  // refers to them by id, so the cloud never holds a recipe whose ingredients it has not got yet.
  await upsertAll(client, 'inventory_items', items);
  await upsertAll(client, 'recipes', recipes);
  const removedRecipes = await deleteStale(client, 'recipes', restaurantId, new Set(recipes.map(r => r.hub_ref)));
  const removedItems = await deleteStale(client, 'inventory_items', restaurantId, new Set(items.map(r => r.hub_ref)));
  return { items: items.length, recipes: recipes.length, removed: removedItems + removedRecipes };
}

const check = ({ data, error }) => {
  if (error) throw error;
  return data || [];
};

/**
 * Reads a restaurant's ingredients and recipes back, in the hub's own shapes. For a replacement hub
 * that starts with nothing. A row with no hub_ref (made by hand in the cloud, not pushed by a hub) is
 * skipped: the hub has no id to give it, and inventing one would orphan any recipe that names it.
 */
export async function pullInventory(client, restaurantId) {
  const itemRows = check(await client.from('inventory_items').select('hub_ref, name, unit, on_hand, low_at').eq('restaurant_id', restaurantId));
  const recipeRows = check(await client.from('recipes').select('hub_ref, menu_item_ref, variant_ref, lines').eq('restaurant_id', restaurantId));

  return {
    items: itemRows
      .filter(r => r.hub_ref)
      .map(r => ({ id: String(r.hub_ref), name: r.name, unit: r.unit, on_hand: Number(r.on_hand) || 0, low_at: Number(r.low_at) || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    recipes: recipeRows
      .filter(r => r.hub_ref)
      .map(r => ({
        id: String(r.hub_ref),
        item_id: String(r.menu_item_ref),
        variant_id: r.variant_ref == null ? null : String(r.variant_ref),
        lines: Array.isArray(r.lines) ? r.lines.map(cleanLine).filter(Boolean) : []
      }))
  };
}
