// Runs database migrations as part of the Vercel build ("migrations run on deploy").
// Locally it does nothing: use `npm run db:reset` against the local Supabase stack.
import { spawnSync } from "node:child_process";

const onVercel = process.env.VERCEL === "1";
const dbUrl = process.env.SUPABASE_DB_URL;

if (!onVercel) {
  console.log("[migrate] not a Vercel build, skipping");
  process.exit(0);
}
if (!dbUrl) {
  // Production must never deploy code ahead of its schema.
  if (process.env.VERCEL_ENV === "production") {
    console.error("[migrate] SUPABASE_DB_URL is not set for production; refusing to build");
    process.exit(1);
  }
  console.warn("[migrate] SUPABASE_DB_URL is not set, skipping migrations for this preview");
  process.exit(0);
}

const result = spawnSync("npx", ["supabase", "db", "push", `--remote=${dbUrl}`, "--include-all", "--yes"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
