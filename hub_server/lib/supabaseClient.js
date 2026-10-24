import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { WebSocket as NodeWebSocket } from 'ws';

dotenv.config();

// supabase-js needs a global WebSocket for Realtime and throws at construction without one
// ("Node.js detected but native WebSocket not found"). Node 22 has it; Node 20 does not, and the
// README promises Node 18 or higher. `ws` is already a dependency -- the hub's own LAN gateway
// runs on it -- so hand that over rather than quietly dropping the Node versions we claim to
// support. On any runtime that has its own WebSocket this is a no-op.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = NodeWebSocket;
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://example.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy';

let inMemoryStorage = {};
const customMemoryStorage = {
  getItem: (key) => inMemoryStorage[key] || null,
  setItem: (key, value) => { inMemoryStorage[key] = value; },
  removeItem: (key) => { delete inMemoryStorage[key]; }
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    storage: customMemoryStorage,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

let isHubAuthenticated = false;

export const checkSupabaseConnection = async () => {
  if (SUPABASE_URL.includes('example.supabase.co')) {
    return { online: false, isNetworkError: true, error: { message: 'Default unconfigured Supabase URL' } };
  }
  try {
    // Ping Supabase REST endpoint to verify network-level connectivity
    const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      method: 'GET',
      headers: { 'apikey': SUPABASE_KEY }
    });
    // Any HTTP status response (200, 400, 401, 403, 404, etc.) confirms network is ONLINE
    return { online: true, status: response.status };
  } catch (err) {
    // True network errors: ENOTFOUND, ECONNREFUSED, fetch failed
    return {
      online: false,
      isNetworkError: true,
      error: { message: err.message || 'Fetch failed', code: err.code || err.name || 'unknown' }
    };
  }
};

/**
 * Authenticates the hub server as the dedicated 'kitchen' staff identity for the
 * paired restaurant. Uses anonymous auth + a staff_users row mapping, deliberately
 * avoiding the service_role key so Supabase RLS still applies.
 *
 * Binding requires HUB_PROVISIONING_SECRET, the per-restaurant secret set during
 * onboarding via set_hub_provisioning_secret(). Before that secret existed, any
 * anonymous caller could bind themselves to any tenant -- see
 * database/migrations/001_secure_hub_provisioning.sql.
 */
export const authenticateHubStaff = async (restaurantId, force = false) => {
  if (!restaurantId || SUPABASE_URL.includes('example.supabase.co')) {
    return { success: false, reason: 'Offline or default Supabase URL' };
  }

  // If already authenticated and session is active, reuse existing session
  if (isHubAuthenticated && !force) {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      return { success: true, staff_id: 'cached', user_id: session.user.id };
    }
  }

  try {
    // 1. Sign in anonymously if not already signed in
    let { data: { session }, error: authErr } = await supabase.auth.getSession();
    
    if (!session) {
      const authRes = await supabase.auth.signInAnonymously();
      session = authRes.data?.session;
      authErr = authRes.error;
    }

    if (authErr || !session?.user) {
      console.warn('ℹ️ Anonymous auth not enabled or failed:', authErr?.message || 'No session');
      return { success: false, error: authErr?.message };
    }

    const userId = session.user.id;

    // 2. Check if staff_users record exists for this user_id
    const { data: existingStaff, error: staffCheckErr } = await supabase
      .from('staff_users')
      .select('id, restaurant_id, role')
      .eq('user_id', userId)
      .maybeSingle();

    if (!staffCheckErr && existingStaff) {
      console.log(`🔐 Hub authenticated as kitchen staff member (Staff ID: ${existingStaff.id}, Auth UID: ${userId})`);
      isHubAuthenticated = true;
      return { success: true, staff: existingStaff, user_id: userId };
    }

    // 3. Bind this session to the tenant's kitchen identity.
    const provisioningSecret = process.env.HUB_PROVISIONING_SECRET;
    if (!provisioningSecret) {
      console.warn(
        '⚠️ HUB_PROVISIONING_SECRET is not set — this hub cannot bind to its tenant, so cloud sync will stay queued.\n' +
        '   Set it in .env to the secret registered for this restaurant via set_hub_provisioning_secret().'
      );
      return { success: false, error: 'HUB_PROVISIONING_SECRET not configured' };
    }

    const { data: staffId, error: rpcErr } = await supabase.rpc('provision_kitchen_staff', {
      p_restaurant_id: restaurantId,
      p_provisioning_secret: provisioningSecret
    });

    if (rpcErr) {
      // The previous direct-table-update fallback here attempted exactly what the
      // secured RPC now refuses, and RLS blocks it regardless. Fail loudly instead.
      console.warn(
        `⚠️ Hub provisioning refused: ${rpcErr.message}\n` +
        '   Check that HUB_PROVISIONING_SECRET matches this restaurant and that migration 001 has been applied.'
      );
      return { success: false, error: rpcErr.message };
    }

    console.log(`✅ Provisioned & bound dedicated 'kitchen' staff role for Hub (Staff ID: ${staffId}, Auth UID: ${userId})`);
    isHubAuthenticated = true;
    return { success: true, staff_id: staffId, user_id: userId };
  } catch (err) {
    console.warn('⚠️ Hub staff auth process error:', err.message);
    return { success: false, error: err.message };
  }
};

