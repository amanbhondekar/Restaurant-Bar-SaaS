// How the alert worker speaks to the database (Phase 2, P2-2). It connects as the dedicated role `kullina_alerts` (migration 024), which holds no privilege on
// any table and may run exactly four functions: read the snapshot, apply a plan, record a page, record a page that failed. Each call is one transaction on the
// database's side, so a plan is applied whole or not at all.

const ROLE = 'kullina_alerts';

/** `query(sql, params)` is node-postgres' (or PGlite's): it resolves to `{ rows }`. */
export function makeAlertDb(query) {
  const value = async (sql, params) => (await query(sql, params)).rows[0].v;
  return {
    snapshot: (limit = 1000) => value('SELECT public.alert_snapshot($1::integer) AS v', [limit]),
    apply: ({ open, resolve, unattended }, requestId = null) => value(
      'SELECT public.alert_apply($1::jsonb, $2::jsonb, $3::jsonb, $4::text) AS v',
      [JSON.stringify(open), JSON.stringify(resolve), JSON.stringify(unattended), requestId]
    ),
    notified: (id, level, requestId = null) => value('SELECT public.alert_notified($1::bigint, $2::integer, $3::text) AS v', [id, level, requestId]),
    notifyFailed: (id, level, note, requestId = null) => value(
      'SELECT public.alert_notify_failed($1::bigint, $2::integer, $3::text, $4::text) AS v', [id, level, note, requestId]
    )
  };
}

/** Refuses to run on a connection that is not the dedicated role, or that could do more than the role can. */
export async function assertAlertRole(query) {
  const { rows } = await query(
    'SELECT current_user AS who, r.rolsuper AS super, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user'
  );
  const me = rows[0];
  if (!me || me.who !== ROLE) throw new Error(`The alert worker must connect to the database as ${ROLE}, not as ${me?.who ?? 'an unknown role'}.`);
  if (me.super) throw new Error(`${ROLE} is a superuser; it must not be.`);
  if (me.bypass) throw new Error(`${ROLE} bypasses row level security; it must not.`);
}
