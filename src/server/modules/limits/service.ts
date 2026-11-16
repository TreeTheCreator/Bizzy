import type { Ctx } from "@/server/context";

export type RateBucket = "mcp" | "mcp.destructive" | "api" | "api.write";

/**
 * Count one request against the caller's per-minute allowance. Returns false
 * when they are over it. The limits themselves are fixed in the database
 * (rate_limit_hit), so a caller cannot raise their own.
 *
 * If the counter cannot be reached the request is allowed: rate limiting
 * protects capacity, it is not the permission check.
 */
// authz: user-scoped (rate_limit_hit() counts only the caller's own requests)
export async function withinRateLimit(ctx: Ctx, bucket: RateBucket): Promise<boolean> {
  const { data, error } = await ctx.db.rpc("rate_limit_hit", { p_bucket: bucket });
  if (error) {
    console.error("[limits] could not count request", error.code);
    return true;
  }
  return data !== false;
}
