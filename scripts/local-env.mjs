// Writes the LOCAL Supabase stack's URL and keys into .env.local, so nobody has
// to copy them by hand. Run after `npm run db:start`:  npm run db:env
// These are throwaway keys for the local Docker stack, never production values.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const result = spawnSync("npx", ["supabase", "status", "-o", "env"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (result.status !== 0) {
  console.error("Could not read the local Supabase status. Is it running? Try: npm run db:start");
  console.error(result.stderr);
  process.exit(1);
}

const status = {};
for (const line of result.stdout.split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
  if (match) status[match[1]] = match[2];
}
const pick = (...names) => names.map((n) => status[n]).find(Boolean);

const values = {
  NEXT_PUBLIC_SUPABASE_URL: pick("API_URL", "SUPABASE_URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: pick("ANON_KEY", "PUBLISHABLE_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: pick("SERVICE_ROLE_KEY", "SECRET_KEY"),
  SUPABASE_DB_URL: pick("DB_URL"),
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
};
const missing = Object.entries(values).filter(([, v]) => !v).map(([k]) => k);
if (missing.length > 0) {
  console.error(`Could not find these values in "supabase status": ${missing.join(", ")}`);
  console.error(`Keys reported: ${Object.keys(status).join(", ")}`);
  process.exit(1);
}

const file = ".env.local";
const kept = existsSync(file)
  ? readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line && !Object.keys(values).some((k) => line.startsWith(`${k}=`)))
  : [];
const written = Object.entries(values).map(([k, v]) => `${k}=${v}`);
writeFileSync(file, [...kept, ...written, ""].join("\n"));
console.log(`Wrote ${written.length} values to ${file} (${Object.keys(values).join(", ")}).`);
