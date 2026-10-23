// A stand-in for the slice of Supabase's client that the operator service uses, backed by arrays, so a test can say what the
// database HOLDS and then check what the service did to it, instead of scripting each call.
//
// It understands exactly the chains the service writes -- select/eq/order/limit/maybeSingle, insert, upsert, update(...).eq(...)
// (optionally .select()) -- and, like Postgres, refuses a duplicate on a unique column with code 23505. Anything else fails loudly,
// because a stand-in that quietly accepts a call the real client would reject proves nothing.

const UNIQUE = {
  subscriptions: ['razorpay_subscription_id'],
  subscription_events: ['razorpay_event_id']
};

export function memoryCloud({ users = {}, staff = [], subscriptions = [], events = [], restaurants = [{ id: 'r-uuid' }], rpcResult, rpcError = null, failures = {} } = {}) {
  const tables = { staff_users: staff, subscriptions, subscription_events: events, restaurants };
  const calls = { rpc: [], updates: [], inserts: [], upserts: [], selects: [], getUser: [] };
  let counter = 0;

  const failure = (op, table) => failures[op]?.[table] ?? null;

  function from(table) {
    if (!tables[table]) throw new Error(`memoryCloud: no table ${table}`);
    const q = { op: 'select', filters: [], order: null, limit: null, single: false, patch: null, onConflict: null, returning: false };

    const matches = row => q.filters.every(([col, val]) => row[col] === val);

    const duplicate = row => (UNIQUE[table] ?? []).some(col => row[col] != null && tables[table].some(r => r[col] === row[col]));

    function run() {
      const rows = tables[table];
      if (q.op === 'select') {
        calls.selects.push({ table, filters: q.filters });
        const bad = failure('select', table);
        if (bad) return { data: null, error: bad };
        let found = rows.filter(matches).map(r => ({ ...r }));
        if (q.order) found.sort((a, b) => (String(a[q.order[0]]) < String(b[q.order[0]]) ? -1 : 1) * (q.order[1] ? 1 : -1));
        if (q.limit != null) found = found.slice(0, q.limit);
        return q.single ? { data: found[0] ?? null, error: null } : { data: found, error: null };
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
      select() { if (q.op === 'update') q.returning = true; return builder; },
      eq(col, val) { q.filters.push([col, val]); return builder; },
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
