import { config } from "dotenv";

// Tests read the same files as local development. .env.test.local wins if present.
config({ path: [".env.test.local", ".env.local"], quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url);

/**
 * Database tests create and delete users and workspaces, so they only ever run
 * against a local Supabase stack unless ALLOW_REMOTE_TESTS=1 is set on purpose.
 */
export const dbTestsEnabled =
  Boolean(url && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY) &&
  (isLocal || process.env.ALLOW_REMOTE_TESTS === "1");

if (!dbTestsEnabled && process.env.REQUIRE_DB_TESTS === "1") {
  throw new Error(
    "REQUIRE_DB_TESTS=1 but the database tests cannot run: set NEXT_PUBLIC_SUPABASE_URL, " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY for a local Supabase stack.",
  );
}
