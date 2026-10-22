import { createClient } from '@supabase/supabase-js';

// The owner page's connection to the cloud project. The address and the ANON key are public by design (they ship in
// every page that talks to Supabase); what protects the data is row-level security and the owner's own sign-in, never
// the secrecy of these two. The service key must never be given to this page.

/** A client, or null when the page has not been told which project to read from (or is pointed at the placeholder). */
export function createOwnerClient(env = import.meta.env) {
  const url = env?.VITE_SUPABASE_URL;
  const key = env?.VITE_SUPABASE_ANON_KEY;
  if (!url || !key || /example\.supabase\.co/.test(url)) return null;
  return createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
}
