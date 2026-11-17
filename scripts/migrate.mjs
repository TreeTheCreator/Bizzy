// Runs database migrations as part of the Vercel build ("migrations run on deploy").
// Locally it does nothing: use `npm run db:reset` against the local Supabase stack.
//
// Only PRODUCTION builds migrate. Preview builds share the production database
// (free plan, one Supabase project), so a preview of an unmerged pull request
// must never change it. A preview of a branch with new migrations will run its
// new code against the old schema; that is expected, and only the preview is affected.
import { spawnSync } from "node:child_process";

const onVercel = process.env.VERCEL === "1";
const production = process.env.VERCEL_ENV === "production";
const dbUrl = process.env.SUPABASE_DB_URL;

if (!onVercel) {
  console.log("[migrate] not a Vercel build, skipping");
  process.exit(0);
}
if (!production) {
  console.log(`[migrate] ${process.env.VERCEL_ENV ?? "unknown"} build: migrations run only on production, skipping`);
  process.exit(0);
}
if (!dbUrl) {
  // Production must never deploy code ahead of its schema.
  console.error("[migrate] SUPABASE_DB_URL is not set for production; refusing to build");
  process.exit(1);
}

// --yes: the build has no terminal, and the Supabase CLI asks before changing a hosted database.
const result = spawnSync("npx", ["supabase", "db", "push", `--remote=${dbUrl}`, "--include-all", "--yes"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
