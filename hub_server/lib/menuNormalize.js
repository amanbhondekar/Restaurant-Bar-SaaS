// Shared defensive normalisation for menu data. Everything that can put a menu
// item into the hub (cloud pull, editor routes, CSV importer) goes through here
// so a malformed row can never reach lib/pricing.js.

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// Variants ship as JSONB (`variants: [{ id, label, price }]`). Entries without a
// usable id/label/numeric price are dropped. Per-variant availability (M2 · PR 14):
// only an explicit `false` marks a variant 86'd.
export function normalizeVariants(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter(v => v && v.id && v.label && Number.isFinite(Number(v.price)))
    .map(v => ({
      id: String(v.id),
      label: String(v.label).slice(0, 40),
      price: Number(v.price),
      available: v.available !== false
    }));
}

// Modifier groups ship as JSONB (`[{ id, label, min, max, options: [{ id, label,
// price_delta }] }]`). An option missing a numeric price_delta is dropped, a group
// missing an id or label is dropped, and a group is only kept when it has at least
// one valid option.
export function normalizeModifierGroups(raw) {
  const rawGroups = Array.isArray(raw) ? raw : [];
  return rawGroups
    .map(g => {
      if (!g || !g.id || !g.label) return null;
      const options = (Array.isArray(g.options) ? g.options : [])
        .filter(o => o && o.id && o.label && Number.isFinite(Number(o.price_delta)))
        .map(o => ({
          id: String(o.id),
          label: String(o.label).slice(0, 40),
          price_delta: Number(o.price_delta),
          available: o.available !== false
        }));
      if (options.length === 0) return null;
      const min = Number.isFinite(Number(g.min)) ? Math.max(0, Math.floor(Number(g.min))) : 0;
      const max = Number.isFinite(Number(g.max)) ? Math.max(min, Math.floor(Number(g.max))) : options.length;
      return { id: String(g.id), label: String(g.label).slice(0, 40), min, max, options };
    })
    .filter(Boolean);
}

// Day-parts ship as JSONB (`[{ id, label, starts_at, ends_at, days?, price?,
// variant_prices? }]`). A window without a valid HH:MM range, or with neither
// `price` nor `variant_prices`, is dropped so lib/dayParts.js never has to guard.
export function normalizeDayParts(raw) {
  const rawDayParts = Array.isArray(raw) ? raw : [];
  return rawDayParts
    .map(dp => {
      if (!dp || !dp.id || !dp.label) return null;
      if (!HHMM.test(String(dp.starts_at)) || !HHMM.test(String(dp.ends_at))) return null;
      const out = {
        id: String(dp.id),
        label: String(dp.label).slice(0, 40),
        starts_at: String(dp.starts_at),
        ends_at: String(dp.ends_at)
      };
      if (Array.isArray(dp.days) && dp.days.length > 0) {
        out.days = dp.days.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
      }
      if (Number.isFinite(Number(dp.price)) && Number(dp.price) >= 0) {
        out.price = Number(dp.price);
      }
      if (dp.variant_prices && typeof dp.variant_prices === 'object') {
        const vp = {};
        for (const [k, v] of Object.entries(dp.variant_prices)) {
          if (Number.isFinite(Number(v)) && Number(v) >= 0) vp[String(k)] = Number(v);
        }
        if (Object.keys(vp).length > 0) out.variant_prices = vp;
      }
      if (out.price === undefined && !out.variant_prices) return null;
      return out;
    })
    .filter(Boolean);
}

// Station routing (M2 · PR 15): lowercased here, whitelisted at read time in
// lib/kotRouting.js so a mistagged row still fires to the main kitchen.
export function normalizeStation(raw) {
  return raw ? String(raw).toLowerCase() : undefined;
}

// Serving course (M2 leftovers): 1 starters, 2 mains, 3 desserts, up to 9. Only an explicit valid
// number is kept; a missing course means 1 and is simply left out of the cached item. It matters only
// when a waiter serves an order in courses (see lib/courses.js).
export function normalizeCourseField(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 && n <= 9 ? n : undefined;
}

// Maps a Supabase `menu_items` row (or an already cache-shaped row) to the hub's
// cache shape.
export function normalizeCloudMenuItem(i) {
  const variants = normalizeVariants(i.variants);
  const modifier_groups = normalizeModifierGroups(i.modifier_groups);
  const day_parts = normalizeDayParts(i.day_parts);
  const station = normalizeStation(i.station);
  const course = normalizeCourseField(i.course);
  return {
    id: i.id,
    name: i.name,
    price: Number(i.price) || 0,
    category: i.category || i.category_name || 'General',
    isVeg: i.is_veg !== undefined ? Boolean(i.is_veg) : Boolean(i.isVeg ?? true),
    available: i.available !== undefined ? Boolean(i.available) : true,
    ...(variants.length > 0 ? { variants } : {}),
    ...(modifier_groups.length > 0 ? { modifier_groups } : {}),
    ...(day_parts.length > 0 ? { day_parts } : {}),
    ...(station ? { station } : {}),
    ...(course ? { course } : {})
  };
}
