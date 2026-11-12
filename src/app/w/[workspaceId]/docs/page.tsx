import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { NoAccess } from "@/components/no-access";
import { authorize } from "@/server/authz/authorize";
import { atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { type DocSummary, DOC_KINDS, listDocs } from "@/server/modules/docs/service";
import { createDocAction } from "./actions";

export const metadata: Metadata = { title: "Docs" };

const KIND_LABELS: Record<(typeof DOC_KINDS)[number], string> = {
  doc: "Doc",
  wiki: "Wiki page",
  sop: "SOP",
};

function DocTree({ docs, parentId, base, depth = 0 }: { docs: DocSummary[]; parentId: string | null; base: string; depth?: number }) {
  // Docs whose parent is missing (or deeper than we render) are shown at the top level.
  const known = new Set(docs.map((d) => d.id));
  const children = docs.filter((d) =>
    parentId === null ? d.parent_id === null || !known.has(d.parent_id) : d.parent_id === parentId,
  );
  if (children.length === 0 || depth > 20) return null;
  return (
    <ul className={depth === 0 ? "space-y-1" : "ml-4 mt-1 space-y-1 border-l border-border pl-3"}>
      {children.map((doc) => (
        <li key={doc.id}>
          <Link className="hover:underline" href={`${base}/${doc.id}`}>{doc.title}</Link>
          {doc.kind !== "doc" && <span className="badge ml-2">{KIND_LABELS[doc.kind]}</span>}
          <DocTree docs={docs} parentId={doc.id} base={base} depth={depth + 1} />
        </li>
      ))}
    </ul>
  );
}

export default async function DocsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ctx = await getWebCtx();
  const loaded = await tryLoad(async () => {
    const access = await authorize(ctx, workspaceId, "docs", "view");
    return { access, docs: await listDocs(ctx, workspaceId) };
  });
  if (loaded.denied) return <NoAccess what="Docs" />;
  const { access, docs } = loaded.data;
  const canEdit = atLeast(access.levels.docs, "edit");
  const base = `/w/${workspaceId}/docs`;

  return (
    <div className="max-w-3xl">
      <h1 className="h1 mb-4">Docs</h1>

      {canEdit && (
        <details className="card mb-4">
          <summary className="cursor-pointer font-medium">New doc</summary>
          <ActionForm action={createDocAction.bind(null, workspaceId)} className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="md:col-span-3">
              <label className="label" htmlFor="new-doc-title">Title</label>
              <input className="input" id="new-doc-title" name="title" required maxLength={200} />
            </div>
            <div>
              <label className="label" htmlFor="new-doc-kind">Type</label>
              <select className="input" id="new-doc-kind" name="kind" defaultValue="doc">
                {DOC_KINDS.map((kind) => (
                  <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="new-doc-parent">Inside</label>
              <select className="input" id="new-doc-parent" name="parentId" defaultValue="">
                <option value="">Top level</option>
                {docs.map((doc) => (
                  <option key={doc.id} value={doc.id}>{doc.title}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <button className="btn btn-primary" type="submit">Create and edit</button>
            </div>
          </ActionForm>
        </details>
      )}

      <section className="card">
        {docs.length === 0 ? (
          <p className="muted">No docs yet{canEdit ? ". Create the first one above." : "."}</p>
        ) : (
          <DocTree docs={docs} parentId={null} base={base} />
        )}
      </section>
    </div>
  );
}
