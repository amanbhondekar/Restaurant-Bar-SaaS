// A stand-in for the slice of Supabase's client that the operator service uses, backed by arrays, so a test can say what the
// database HOLDS and then check what the service did to it, instead of scripting each call.
//
// It understands exactly the chains the service writes -- select (with a count)/eq/lt/lte/gt/gte/order/limit/maybeSingle, insert,
// upsert, update(...).eq(...) (optionally .select()), delete().eq(...) -- and, like Postgres, refuses a duplicate on a unique column with code 23505. Anything else fails loudly,
// because a stand-in that quietly accepts a call the real client would reject proves nothing.

const UNIQUE = {
  subscriptions: ['razorpay_subscription_id'],
  subscription_events: ['razorpay_event_id'],
  booking_pages: ['restaurant_id', 'code']
};

// Timestamps arrive as ISO strings and compare as moments; anything else compares as it is.
const comparable = v => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : v);
const TESTS = {
  eq: (a, b) => a === b,
  lt: (a, b) => comparable(a) < comparable(b),
  lte: (a, b) => comparable(a) <= comparable(b),
  gt: (a, b) => comparable(a) > comparable(b),
  gte: (a, b) => comparable(a) >= comparable(b),
  in: (a, list) => Array.isArray(list) && list.includes(a)
};

export function memoryCloud({ users = {}, staff = [], subscriptions = [], events = [], restaurants = [{ id: 'r-uuid' }], bookingPages = [], bookingRequests = [], rpcResult, rpcError = null, failures = {} } = {}) {
  const tables = { staff_users: staff, subscriptions, subscription_events: events, restaurants, booking_pages: bookingPages, booking_requests: bookingRequests };
  const calls = { rpc: [], updates: [], inserts: [], upserts: [], selects: [], deletes: [], getUser: [] };
  let counter = 0;

  const failure = (op, table) => failures[op]?.[table] ?? null;

  function from(table) {
    if (!tables[table]) throw new Error(`memoryCloud: no table ${table}`);
    const q = { op: 'select', filters: [], order: null, limit: null, single: false, patch: null, onConflict: null, returning: false, count: false, head: false };

    const matches = row => q.filters.every(([col, val, op = 'eq']) => TESTS[op](row[col], val));

    const duplicate = row => (UNIQUE[table] ?? []).some(col => row[col] != null && tables[table].some(r => r[col] === row[col]));

    function run() {
      const rows = tables[table];
      if (q.op === 'select') {
        calls.selects.push({ table, filters: q.filters });
        const bad = failure('select', table);
        if (bad) return { data: null, error: bad };
        let found = rows.filter(matches).map(r => ({ ...r }));
        if (q.head) return { data: null, count: found.length, error: null };
        if (q.order) found.sort((a, b) => (String(a[q.order[0]]) < String(b[q.order[0]]) ? -1 : 1) * (q.order[1] ? 1 : -1));
        if (q.limit != null) found = found.slice(0, q.limit);
        return q.single ? { data: found[0] ?? null, error: null } : { data: found, ...(q.count ? { count: found.length } : {}), error: null };
      }
      if (q.op === 'delete') {
        calls.deletes.push({ table, filters: q.filters });
        const bad = failure('delete', table);
        if (bad) return { data: null, error: bad };
        const keep = rows.filter(r => !matches(r));
        const removed = rows.length - keep.length;
        rows.splice(0, rows.length, ...keep);
        return { data: null, count: removed, error: null };
      }
      if (q.op === 'insert') {
        calls.inserts.push({ table, row: q.patch });
        const bad = failure('insert', table);
        if (bad) return { data: null, error: bad };
        if (duplicate(q.patch)) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint on ${table}` } };
        const row = { id: `${table}-${++counter}`, created_at: new Date().toISOString(), ...q.patch };
        rows.push(row);
        return { data: { ...row }, error: null };
      }
      if (q.op === 'upsert') {
        calls.upserts.push({ table, row: q.patch, onConflict: q.onConflict });
        const bad = failure('upsert', table);
        if (bad) return { data: null, error: bad };
        const existing = rows.find(r => r[q.onConflict] === q.patch[q.onConflict]);
        if (existing) { Object.assign(existing, q.patch); return { data: { ...existing }, error: null }; }
        const row = { id: `${table}-${++counter}`, created_at: new Date().toISOString(), ...q.patch };
        rows.push(row);
        return { data: { ...row }, error: null };
      }
      if (q.op === 'update') {
        const [col, val] = q.filters[0] ?? [];
        calls.updates.push({ table, patch: q.patch, col, val });
        const bad = failure('update', table);
        if (bad) return { data: null, error: bad };
        const hit = rows.filter(matches);
        for (const r of hit) Object.assign(r, q.patch);
        return { data: q.returning ? hit.map(r => ({ ...r })) : null, error: null };
      }
      throw new Error(`memoryCloud: unsupported op ${q.op}`);
    }

    const builder = {
      select(_cols, { count = null, head = false } = {}) { if (q.op === 'update') q.returning = true; q.count = Boolean(count); q.head = head; return builder; },
      eq(col, val) { q.filters.push([col, val]); return builder; },
      in(col, vals) { q.filters.push([col, vals, 'in']); return builder; },
      lt(col, val) { q.filters.push([col, val, 'lt']); return builder; },
      lte(col, val) { q.filters.push([col, val, 'lte']); return builder; },
      gt(col, val) { q.filters.push([col, val, 'gt']); return builder; },
      gte(col, val) { q.filters.push([col, val, 'gte']); return builder; },
      delete() { q.op = 'delete'; return builder; },
      order(col, { ascending = true } = {}) { q.order = [col, ascending]; return builder; },
      limit(n) { q.limit = n; return builder; },
      maybeSingle() { q.single = true; return builder; },
      insert(row) { q.op = 'insert'; q.patch = row; return builder; },
      upsert(row, opts = {}) { q.op = 'upsert'; q.patch = row; q.onConflict = opts.onConflict; return builder; },
      update(patch) { q.op = 'update'; q.patch = patch; return builder; },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); }
    };
    return builder;
  }

  return {
    calls,
    tables,
    from,
    rpc: async (fn, args) => {
      calls.rpc.push({ fn, args });
      return rpcError ? { data: null, error: rpcError } : { data: rpcResult, error: null };
    },
    auth: {
      getUser: async token => {
        calls.getUser.push(token);
        const user = users[token];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } };
      }
    }
  };
}
