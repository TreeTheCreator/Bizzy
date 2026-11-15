import { adminDb } from "@/server/db/admin";

/**
 * The orphaned-file cleanup worker. Runs from a daily cron sweep. It removes
 * stored objects that no file row points to: uploads that were never
 * confirmed, and leftovers of deletes that failed half-way.
 *
 * It calls one database function, file_orphans(), which only returns objects
 * older than a day, then removes exactly those paths through the Storage API.
 */

const BUCKET = "workspace-files";

/**
 * Remove up to `limit` orphaned objects. Does nothing when the service-role
 * key is not configured. Returns how many were removed. Never throws.
 */
export async function sweepOrphanFiles(limit = 200): Promise<number> {
  try {
    const db = adminDb();
    if (!db) return 0;
    const { data, error } = await db.rpc("file_orphans", { p_limit: limit });
    if (error) {
      console.error("[files] could not list orphaned objects", error.code);
      return 0;
    }
    const paths = (data ?? []) as string[];
    if (paths.length === 0) return 0;
    const removed = await db.storage.from(BUCKET).remove(paths);
    if (removed.error) {
      console.error("[files] could not remove orphaned objects", removed.error.message);
      return 0;
    }
    return removed.data?.length ?? 0;
  } catch (error) {
    console.error("[files] sweep failed", error);
    return 0;
  }
}
