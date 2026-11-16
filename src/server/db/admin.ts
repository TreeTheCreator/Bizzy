import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { supabaseEnv } from "@/lib/env";

/**
 * The service-role client. It bypasses row-level security, so it is used only
 * by the two background workers, which must work across every workspace:
 * webhook delivery (src/server/webhooks/deliver.ts) and orphaned-file cleanup
 * (src/server/files/cleanup.ts). Nothing that serves a user's request may
 * import this file; a test enforces that.
 */
export function adminDb(): SupabaseClient | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient(supabaseEnv().url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
