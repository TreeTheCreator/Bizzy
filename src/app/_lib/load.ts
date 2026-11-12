import { notFound } from "next/navigation";
import { AppError } from "@/server/errors";

/**
 * Load data for a page. A permission denial becomes `{ denied: true }` so the
 * page can show a "no access" message; a missing item becomes a 404.
 */
export async function tryLoad<T>(fn: () => Promise<T>): Promise<{ data: T; denied?: false } | { denied: true }> {
  try {
    return { data: await fn() };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === "permission_denied") return { denied: true };
      if (error.code === "not_found" || error.code === "invalid") notFound();
    }
    throw error;
  }
}
