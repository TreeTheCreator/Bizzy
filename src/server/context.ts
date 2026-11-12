import type { SupabaseClient } from "@supabase/supabase-js";

/** Which entry point a request came through. */
export type Channel = "web" | "api" | "mcp";

/**
 * The caller of a service function.
 *
 * `db` is a Supabase client authenticated AS THE USER, so row-level security
 * applies to every query made through it. Services never use a service-role client.
 */
export interface Ctx {
  userId: string;
  email: string;
  db: SupabaseClient;
  channel: Channel;
}
