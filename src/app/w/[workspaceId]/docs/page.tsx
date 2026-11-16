import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { ModalButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { EmptyState, PageHeader } from "@/components/ui";
import { authorize } from "@/server/authz/authorize";
import { atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { type DocSummary, DOC_KINDS, listDocs } from "@/server/modules/docs/service";
import { createDocAction } from "./actions";
import { KIND_LABELS } from "./kinds";

export const metadata: Metadata = { title: "Docs" };

function DocTree({ docs, parentId, base, depth = 0 }: { docs: DocSummary[]; parentId: string | null; base: string; depth?: number }) {
  // Docs whose parent is missing (or deeper than we render) are shown at the top level.
  const known = new Set(docs.map((d) => d.id));
  const children = docs.filter((d) =>
    parentId === null ? d.parent_id === null || !known.has(d.parent_id) : d.parent_id === parentId,
  );
  if (children.length === 0 || depth > 20) return null;
  return (
    <ul className={depth === 0 ? "" : "ml-3 border-l border-border pl-3"}>
      {children.map((doc) => (
        <li key={doc.id}>
          <Link className="flex min-h-11 items-center gap-3 rounded-lg px-2 hover:bg-bg" href={`${base}/${doc.id}`}>
            <Icon name="docs" className="text-muted" />
            <span className="min-w-0 flex-1 truncate font-medium">{doc.title}</span>
            {doc.kind !== "doc" && <span className="pill">{KIND_LABELS[doc.kind]}</span>}
          </Link>
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

  const newDoc = (label: string) => (
    <ModalButton label={label} title="New doc" icon="plus">
      <ActionForm action={createDocAction.bind(null, workspaceId)} className="space-y-4">
        <div>
          <label className="label" htmlFor="new-doc-title">Title</label>
          <input className="input" id="new-doc-title" name="title" placeholder="How we open the shop" required maxLength={200} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="new-doc-kind">What kind of doc?</label>
            <select className="input" id="new-doc-kind" name="kind" defaultValue="doc">
              {DOC_KINDS.map((kind) => (
                <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="new-doc-parent">Keep it inside</label>
            <select className="input" id="new-doc-parent" name="parentId" defaultValue="">
              <option value="">Nothing (top of the list)</option>
              {docs.map((doc) => (
                <option key={doc.id} value={doc.id}>{doc.title}</option>
              ))}
            </select>
          </div>
        </div>
        <button className="btn btn-primary w-full sm:w-auto" type="submit">Create and start writing</button>
      </ActionForm>
    </ModalButton>
  );

  return (
    <div className="max-w-3xl">
      <PageHeader title="Docs">{canEdit && newDoc("New doc")}</PageHeader>

      {docs.length === 0 ? (
        <EmptyState
          icon="docs"
          title={canEdit ? "Write your first doc" : "No docs yet"}
          body="Keep notes, how-to guides and files here so everyone can find them."
        >
          {canEdit && newDoc("Write a doc")}
        </EmptyState>
      ) : (
        <section className="card p-3">
          <DocTree docs={docs} parentId={null} base={base} />
        </section>
      )}
    </div>
  );
}
