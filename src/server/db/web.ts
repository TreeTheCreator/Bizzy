import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseEnv } from "@/lib/env";
import type { Ctx } from "@/server/context";

/**
 * A Supabase client bound to the signed-in user's session cookies.
 * Queries made with it run as that user, under row-level security.
 */
export async function createWebDb(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const { url, anonKey } = supabaseEnv();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; the proxy refreshes the session instead.
        }
      },
    },
  });
}

/** The signed-in caller, or null. The user is verified with the auth server, not just read from a cookie. */
export async function getOptionalCtx(): Promise<Ctx | null> {
  const db = await createWebDb();
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) return null;
  return { userId: data.user.id, email: data.user.email ?? "", db, channel: "web" };
}

/** The signed-in caller; sends signed-out visitors to the sign-in page. */
export async function getWebCtx(nextPath?: string): Promise<Ctx> {
  const ctx = await getOptionalCtx();
  if (!ctx) redirect(nextPath ? `/sign-in?next=${encodeURIComponent(nextPath)}` : "/sign-in");
  return ctx;
}

/** Public base URL of this deployment, for links shown to users. */
export async function appUrl(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
