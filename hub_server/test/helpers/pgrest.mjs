// Just enough of supabase-js's query builder, answered by the real Postgres in helpers/cloudDb.mjs, to run client code
// against the actual schema, row-level security, column privileges and constraints, signed in as a given user.
//
//   const client = pgrestClient(cloud, ownerUserId);
//   const { data, error } = await client.from('invoices').select('id, hub_ref').eq('restaurant_id', rid).order('issued_at').range(0, 999);
//   await client.from('inventory_items').upsert(rows, { onConflict: 'restaurant_id,hub_ref' });
//
// Supported: select(columns, { count, head }), eq, in, gte, lte, or('col.op.value,...'), order, limit, range, maybeSingle,
// upsert(rows, { onConflict, ignoreDuplicates }), delete(), and awaiting the result.
// Errors come back as { message, code } the way PostgREST reports them. Everything runs as the signed-in user, so a write
// the database would refuse is refused here too.

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = name => { if (!IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`); return `"${name}"`; };
const OPS = { eq: '=', gte: '>=', lte: '<=' };

/** PostgREST speaks JSON: timestamps as ISO strings. PGlite hands back Date objects. */
const plain = value => (value instanceof Date ? value.toISOString() : value);

class Query {
  constructor(cloud, userId, table) {
    this.cloud = cloud; this.userId = userId; this.table = table;
    this.cols = '*'; this.where = []; this.params = []; this.orders = []; this.max = null; this.skip = 0;
    this.mode = 'select'; this.countOnly = false; this.single = false; this.rows = []; this.upsertOptions = {};
  }

  select(cols = '*', { count = null, head = false } = {}) { this.cols = cols; this.countOnly = Boolean(count && head); return this; }

  maybeSingle() { this.single = true; return this; }

  delete() { this.mode = 'delete'; return this; }

  upsert(rows, options = {}) { this.mode = 'upsert'; this.rows = Array.isArray(rows) ? rows : [rows]; this.upsertOptions = options; return this; }

  in(col, values) {
    this.params.push(values);
    this.where.push(`${ident(col)} = ANY($${this.params.length})`);
    return this;
  }

  filter(col, op, value) {
    this.params.push(value);
    this.where.push(`${ident(col)} ${OPS[op]} $${this.params.length}`);
    return this;
  }
  eq(col, value) { return this.filter(col, 'eq', value); }
  gte(col, value) { return this.filter(col, 'gte', value); }
  lte(col, value) { return this.filter(col, 'lte', value); }

  or(expression) {
    const parts = String(expression).split(',').map(clause => {
      const [col, op, ...rest] = clause.split('.');
      if (!OPS[op]) throw new Error(`unsupported or() operator: ${op}`);
      this.params.push(rest.join('.'));
      return `${ident(col)} ${OPS[op]} $${this.params.length}`;
    });
    this.where.push(`(${parts.join(' OR ')})`);
    return this;
  }

  order(col, { ascending = true } = {}) { this.orders.push(`${ident(col)} ${ascending ? 'ASC' : 'DESC'}`); return this; }
  limit(n) { this.max = n; return this; }
  range(from, to) { this.skip = from; this.max = to - from + 1; return this; }

  async run() {
    try {
      const result = await this.cloud.as('authenticated', this.userId, () => this.execute());
      return result;
    } catch (e) {
      return { data: null, error: { message: e.message, code: e.code || 'PGRST000' } };
    }
  }

  async execute() {
    const pg = this.cloud.pg;
    const where = this.where.length ? ` WHERE ${this.where.join(' AND ')}` : '';

    if (this.mode === 'delete') {
      const r = await pg.query(`DELETE FROM public.${ident(this.table)}${where}`, this.params);
      return { data: null, error: null, count: r.affectedRows ?? 0 };
    }

    if (this.mode === 'upsert') {
      if (this.rows.length === 0) return { data: null, error: null };
      const columns = [...new Set(this.rows.flatMap(r => Object.keys(r)))];
      const list = columns.map(ident).join(', ');
      const keys = String(this.upsertOptions.onConflict || '').split(',').filter(Boolean);
      const action = this.upsertOptions.ignoreDuplicates
        ? `ON CONFLICT (${keys.map(ident).join(', ')}) DO NOTHING`
        : keys.length
          ? `ON CONFLICT (${keys.map(ident).join(', ')}) DO UPDATE SET ${columns.filter(c => !keys.includes(c)).map(c => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')}`
          : '';
      await pg.query(`INSERT INTO public.${ident(this.table)} (${list}) SELECT ${list} FROM jsonb_populate_recordset(null::public.${ident(this.table)}, $1::jsonb) ${action}`, [JSON.stringify(this.rows)]);
      return { data: null, error: null };
    }

    if (this.countOnly) {
      const r = await pg.query(`SELECT count(*)::int AS n FROM public.${ident(this.table)}${where}`, this.params);
      return { data: null, error: null, count: r.rows[0].n };
    }

    const cols = this.cols === '*' ? '*' : this.cols.split(',').map(c => ident(c.trim())).join(', ');
    const sql = `SELECT ${cols} FROM public.${ident(this.table)}`
      + where
      + (this.orders.length ? ` ORDER BY ${this.orders.join(', ')}` : '')
      + (this.max !== null ? ` LIMIT ${Number(this.max)}` : '')
      + (this.skip ? ` OFFSET ${Number(this.skip)}` : '');
    const result = await pg.query(sql, this.params);
    const data = result.rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)])));
    return { data: this.single ? (data[0] ?? null) : data, error: null };
  }

  then(resolve, reject) { return this.run().then(resolve, reject); }
}

export function pgrestClient(cloud, userId) {
  return { from: table => new Query(cloud, userId, table) };
}
