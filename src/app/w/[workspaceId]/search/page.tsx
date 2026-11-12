import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { NoAccess } from "@/components/no-access";
import { PAGE_LABELS } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { search } from "@/server/modules/search/service";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { workspaceId } = await params;
  const q = ((await searchParams).q ?? "").slice(0, 100);
  const ctx = await getWebCtx();
  const loaded = await tryLoad(() => search(ctx, workspaceId, q));
  if (loaded.denied) return <NoAccess what="search" />;
  const hits = loaded.data;

  return (
    <div className="max-w-2xl">
      <h1 className="h1 mb-4">Search</h1>
      <form className="mb-4 flex gap-2">
        <input className="input" type="search" name="q" defaultValue={q} aria-label="Search" placeholder="Search tasks and docs" />
        <button className="btn btn-primary" type="submit">Search</button>
      </form>
      {q.trim().length >= 2 && (
        <section className="card">
          {hits.length === 0 ? (
            <p className="muted">No results in the pages you can see.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {hits.map((hit) => (
                <li key={`${hit.page}-${hit.id}`}>
                  <span className="badge mr-2">{PAGE_LABELS[hit.page]}</span>
                  <Link className="hover:underline" href={hit.link}>{hit.title}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
