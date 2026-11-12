import { authorizeAnyAccess } from "@/server/authz/authorize";
import { atLeast } from "@/server/authz/pages";
import type { Ctx } from "@/server/context";
import { unwrap } from "@/server/errors";
import { id, parse } from "@/server/validate";

export interface SearchHit {
  page: "tasks" | "docs";
  id: string;
  title: string;
  link: string;
}

/**
 * Search across the pages the caller can view. A page the caller cannot view
 * is not queried at all (and RLS would return nothing anyway).
 */
export async function search(ctx: Ctx, workspaceId: string, query: string): Promise<SearchHit[]> {
  const access = await authorizeAnyAccess(ctx, parse(id, workspaceId));
  // Strip characters that have meaning in PostgREST filters or LIKE patterns.
  const term = query.replace(/[%_\\,()*"']/g, " ").trim().slice(0, 100);
  if (term.length < 2) return [];
  const pattern = `%${term}%`;
  const hits: SearchHit[] = [];

  if (atLeast(access.levels.tasks, "view")) {
    const tasks = unwrap<{ id: string; title: string }[]>(
      await ctx.db
        .from("tasks")
        .select("id, title")
        .eq("workspace_id", workspaceId)
        .or(`title.ilike.${pattern},description.ilike.${pattern}`)
        .limit(25),
    );
    hits.push(
      ...tasks.map((t) => ({
        page: "tasks" as const,
        id: t.id,
        title: t.title,
        link: `/w/${workspaceId}/tasks/${t.id}`,
      })),
    );
  }

  if (atLeast(access.levels.docs, "view")) {
    const docs = unwrap<{ id: string; title: string }[]>(
      await ctx.db
        .from("docs")
        .select("id, title")
        .eq("workspace_id", workspaceId)
        .or(`title.ilike.${pattern},content.ilike.${pattern}`)
        .limit(25),
    );
    hits.push(
      ...docs.map((d) => ({
        page: "docs" as const,
        id: d.id,
        title: d.title,
        link: `/w/${workspaceId}/docs/${d.id}`,
      })),
    );
  }

  return hits;
}
