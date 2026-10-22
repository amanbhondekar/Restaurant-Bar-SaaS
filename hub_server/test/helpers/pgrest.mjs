// Just enough of supabase-js's query builder, answered by the real Postgres in helpers/cloudDb.mjs, to run client code
// against the actual schema, row-level security and column privileges, signed in as a given user.
//
//   const client = pgrestClient(cloud, ownerUserId);
//   const { data, error } = await client.from('invoices').select('id, hub_ref').eq('restaurant_id', rid).order('issued_at').range(0, 999);
//
// Supported: select(columns), eq, gte, lte, or('col.op.value,...'), order, limit, range, and awaiting the result.
// Errors come back as { message, code } the way PostgREST reports them. Writes are deliberately NOT supported: the
// clients under test read, and a test that wants to prove a write is refused does it in SQL.

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = name => { if (!IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`); return `"${name}"`; };
const OPS = { eq: '=', gte: '>=', lte: '<=' };

/** PostgREST speaks JSON: timestamps as ISO strings. PGlite hands back Date objects. */
const plain = value => (value instanceof Date ? value.toISOString() : value);

class Query {
  constructor(cloud, userId, table) {
    this.cloud = cloud; this.userId = userId; this.table = table;
    this.cols = '*'; this.where = []; this.params = []; this.orders = []; this.max = null; this.skip = 0;
  }

  select(cols = '*') { this.cols = cols; return this; }

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
    const cols = this.cols === '*' ? '*' : this.cols.split(',').map(c => ident(c.trim())).join(', ');
    const sql = `SELECT ${cols} FROM public.${ident(this.table)}`
      + (this.where.length ? ` WHERE ${this.where.join(' AND ')}` : '')
      + (this.orders.length ? ` ORDER BY ${this.orders.join(', ')}` : '')
      + (this.max !== null ? ` LIMIT ${Number(this.max)}` : '')
      + (this.skip ? ` OFFSET ${Number(this.skip)}` : '');
    try {
      const result = await this.cloud.as('authenticated', this.userId, () => this.cloud.pg.query(sql, this.params));
      return { data: result.rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)]))), error: null };
    } catch (e) {
      return { data: null, error: { message: e.message, code: e.code || 'PGRST000' } };
    }
  }

  then(resolve, reject) { return this.run().then(resolve, reject); }
}

export function pgrestClient(cloud, userId) {
  return { from: table => new Query(cloud, userId, table) };
}
