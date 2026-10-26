// How the admin API speaks to the database (decision D1). It connects as the dedicated role `kullina_admin`, which holds no privilege on any table
// and may run only the admin_* functions; each request is one transaction in which the caller's claims are put where those functions look for them
// (`request.jwt.claims`), so the database checks who is asking and whether they used a second factor, again, after the API already did.

const ROLE = 'kullina_admin';

/**
 * `transaction(fn)` runs `fn({ query })` inside BEGIN ... COMMIT (ROLLBACK if it throws). A node-postgres pool is wrapped by `poolTransaction`;
 * the tests hand in PGlite's.
 */
export function makeAdminDb({ transaction }) {
  return {
    async asAdmin(claims, fn) {
      const sub = claims && typeof claims.sub === 'string' ? claims.sub : '';
      if (!sub) throw new Error('A caller needs a subject: there are no claims to act on behalf of.');
      // Only what the functions read is passed on, and the role is always the ordinary one, whatever the token said.
      const passed = JSON.stringify({ sub, aal: claims.aal, role: 'authenticated' });
      return transaction(async tx => {
        await tx.query(`SET LOCAL ROLE ${ROLE}`);
        await tx.query("SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [passed, sub]);
        return fn((sql, params) => tx.query(sql, params));
      });
    }
  };
}

/** Wraps a node-postgres Pool as the `transaction` function above. */
export function poolTransaction(pool) {
  return async fn => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* the connection is gone; the original error is the one to report */ }
      throw err;
    } finally {
      client.release();
    }
  };
}

/** Refuses to start on a connection that is not the dedicated role, or that could do more than the role can. */
export async function assertDedicatedRole(query) {
  const { rows } = await query(
    'SELECT current_user AS who, r.rolsuper AS super, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user'
  );
  const me = rows[0];
  if (!me || me.who !== ROLE) throw new Error(`The API must connect to the database as ${ROLE}, not as ${me?.who ?? 'an unknown role'}.`);
  if (me.super) throw new Error(`${ROLE} is a superuser; it must not be.`);
  if (me.bypass) throw new Error(`${ROLE} bypasses row level security; it must not.`);
}
