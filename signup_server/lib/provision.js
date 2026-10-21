import crypto from 'crypto';

// Creating a tenant, and reacting to what Razorpay says about it (§4.4).
//
// Why this is its own service. `provision_restaurant()` is deliberately unreachable from the API --
// migration 007 revokes it from `anon` and `authenticated`, because anything that can call it can
// fill the restaurants table. Its own comment says it is for "a trusted signup service with its own
// credentials", and this is that service. The same goes for a Razorpay webhook, which needs a public
// address the hub does not have and a key the hub must never hold.
//
// So this is the one place that holds privileged credentials: the Supabase service key and the
// Razorpay webhook secret. It is small on purpose. Everything here is pure; server.js does the HTTP.

const SECRET_BYTES = 24;   // 48 hex characters; migration 007 refuses anything under 16

/** The secret that binds one hub to one tenant. Generated here, shown once, stored only as a bcrypt hash. */
export const newProvisioningSecret = () => crypto.randomBytes(SECRET_BYTES).toString('hex');

const PLANS = ['starter', 'pro', 'enterprise'];

/**
 * Check a signup before the database is asked. The same rules `provision_restaurant()` enforces, so
 * a mistake comes back as a sentence beside the field instead of a Postgres exception.
 */
export function validateSignup(input) {
  const errors = [];
  const out = {};
  const text = (key, label, max) => {
    const value = typeof input?.[key] === 'string' ? input[key].trim() : '';
    if (!value) errors.push({ field: key, message: `${label} is required.` });
    else if (value.length > max) errors.push({ field: key, message: `${label} can be at most ${max} characters.` });
    else out[key] = value;
  };

  text('name', 'The restaurant name', 120);
  text('city', 'A city', 80);

  for (const [key, max] of [['cuisine', 80], ['address', 200], ['phone', 20]]) {
    const value = typeof input?.[key] === 'string' ? input[key].trim() : '';
    if (value.length > max) errors.push({ field: key, message: `At most ${max} characters.` });
    else if (value) out[key] = value;
  }

  const plan = input?.plan ?? 'starter';
  if (!PLANS.includes(plan)) errors.push({ field: 'plan', message: `A plan must be one of ${PLANS.join(', ')}.` });
  else out.plan = plan;

  return errors.length ? { ok: false, errors } : { ok: true, signup: out };
}

/** The RPC arguments `provision_restaurant()` takes. Named, because it has nine parameters. */
export function provisionArgs(signup, secret) {
  return {
    p_name: signup.name,
    p_city: signup.city,
    p_secret: secret,
    ...(signup.cuisine ? { p_cuisine: signup.cuisine } : {}),
    ...(signup.address ? { p_address: signup.address } : {}),
    ...(signup.phone ? { p_phone: signup.phone } : {}),
    p_plan: signup.plan ?? 'starter'
  };
}

/**
 * What the operator is told after a tenant is created.
 *
 * The secret appears here and nowhere else, ever: the database keeps only a bcrypt hash of it, so if
 * this is lost the only way back is to set a new one. Saying so is part of the answer.
 */
export function describeProvisioned({ restaurant_id, pairing_code, slug, trial_ends_at }, secret) {
  return {
    restaurant_id,
    pairing_code,
    slug,
    trial_ends_at,
    hub_provisioning_secret: secret,
    next_steps: [
      `Put HUB_PROVISIONING_SECRET=${secret} in that hub's .env file.`,
      `Start the hub and pair it with the code ${pairing_code}.`,
      'This secret is shown once. The database keeps only a hash of it, so if it is lost you must set a new one.'
    ]
  };
}

/**
 * Whether a request carries the operator token.
 *
 * Creating tenants is not a public act. Compared in constant time, and a service started without a
 * token configured refuses EVERY request rather than defaulting to open -- the failure mode of a
 * missing environment variable should not be "anyone may create restaurants".
 */
export function isOperator(suppliedToken, configuredToken) {
  if (!configuredToken || typeof configuredToken !== 'string') return false;
  if (!suppliedToken || typeof suppliedToken !== 'string') return false;
  const a = crypto.createHash('sha256').update(suppliedToken).digest();
  const b = crypto.createHash('sha256').update(configuredToken).digest();
  return crypto.timingSafeEqual(a, b);
}
