import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { NoAccess } from "@/components/no-access";
import { PageHeader } from "@/components/ui";
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
      <PageHeader title="Search" />
      <form className="mb-5 flex gap-2" role="search">
        <input className="input" type="search" name="q" defaultValue={q} aria-label="Search" placeholder="Type a word to look for" />
        <button className="btn btn-primary" type="submit">Search</button>
      </form>
      {q.trim().length >= 2 && (
        <section className="card">
          {hits.length === 0 ? (
            <p className="muted">Nothing found for &ldquo;{q}&rdquo;. Try a shorter or different word.</p>
          ) : (
            <ul>
              {hits.map((hit) => (
                <li key={`${hit.page}-${hit.id}`} className="row">
                  <Link className="min-w-0 flex-1 font-medium hover:underline" href={hit.link}>{hit.title}</Link>
                  <span className="pill">{PAGE_LABELS[hit.page]}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
