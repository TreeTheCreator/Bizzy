import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { BackLink } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { authorize } from "@/server/authz/authorize";
import { atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { DOC_KINDS, getDoc, listDocs } from "@/server/modules/docs/service";
import { deleteDocAction, deleteFileAction, updateDocAction } from "../actions";
import { KIND_LABELS } from "../kinds";
import { FileUpload } from "../upload";

export const metadata: Metadata = { title: "Doc" };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function DocPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; docId: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { workspaceId, docId } = await params;
  const wantsEdit = (await searchParams).edit === "1";
  const ctx = await getWebCtx();
  const loaded = await tryLoad(async () => {
    const access = await authorize(ctx, workspaceId, "docs", "view");
    const [{ doc, files }, docs] = await Promise.all([getDoc(ctx, workspaceId, docId), listDocs(ctx, workspaceId)]);
    return { access, doc, files, docs };
  });
  if (loaded.denied) return <NoAccess what="Docs" />;
  const { access, doc, files, docs } = loaded.data;
  const canEdit = atLeast(access.levels.docs, "edit");
  const canManage = atLeast(access.levels.docs, "manage");
  const editing = wantsEdit && canEdit;
  const base = `/w/${workspaceId}/docs`;
  const parent = docs.find((d) => d.id === doc.parent_id);

  return (
    <div className="max-w-3xl">
      <BackLink href={parent ? `${base}/${parent.id}` : base}>{parent ? `Back to ${parent.title}` : "Back to docs"}</BackLink>

      {editing ? (
        <section className="card mb-6">
          <ActionForm action={updateDocAction.bind(null, workspaceId, docId)} className="space-y-4">
            <div>
              <label className="label" htmlFor="doc-title">Title</label>
              <input className="input" id="doc-title" name="title" defaultValue={doc.title} required maxLength={200} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="doc-kind">What kind of doc?</label>
                <select className="input" id="doc-kind" name="kind" defaultValue={doc.kind}>
                  {DOC_KINDS.map((kind) => (
                    <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="doc-parent">Keep it inside</label>
                <select className="input" id="doc-parent" name="parentId" defaultValue={doc.parent_id ?? ""}>
                  <option value="">Nothing (top of the list)</option>
                  {docs.filter((d) => d.id !== doc.id).map((d) => (
                    <option key={d.id} value={d.id}>{d.title}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="doc-content">Text</label>
              <textarea className="input min-h-96 leading-7" id="doc-content" name="content" defaultValue={doc.content} />
            </div>
            <div className="flex gap-2">
              <button className="btn btn-primary" type="submit">Save</button>
              <Link className="btn" href={`${base}/${docId}`}>Stop editing</Link>
            </div>
          </ActionForm>
        </section>
      ) : (
        <article className="card mb-6">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="h1">{doc.title}</h1>
              <p className="muted">
                {KIND_LABELS[doc.kind]} · last changed {formatDate(doc.updated_at)}
              </p>
            </div>
            {canEdit && <Link className="btn" href={`${base}/${docId}?edit=1`}>Edit</Link>}
          </div>
          {/* Content is rendered as plain text: stored content is data, never markup. */}
          <div className="whitespace-pre-wrap leading-7">{doc.content || "Nothing has been written here yet."}</div>
        </article>
      )}

      <section className="card mb-6">
        <h2 className="h2 mb-3">Files</h2>
        {files.length === 0 && <p className="muted mb-3">No files have been added.</p>}
        <ul className="mb-3">
          {files.map((file) => (
            <li key={file.id} className="row">
              <span className="min-w-0 flex-1">
                <a className="link" href={`/api/files/${workspaceId}/${file.id}`}>{file.name}</a>
                <span className="ml-2 text-muted">{formatBytes(file.size_bytes)}</span>
              </span>
              {canManage && (
                <ActionForm action={deleteFileAction.bind(null, workspaceId)}>
                  <input type="hidden" name="fileId" value={file.id} />
                  <ConfirmButton
                    className="btn btn-sm btn-danger"
                    title={`Delete the file "${file.name}"?`}
                    message="The file is removed for good. You can't undo this."
                    confirmLabel="Delete file"
                  >
                    Delete
                  </ConfirmButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
        {canEdit && <FileUpload workspaceId={workspaceId} docId={docId} />}
      </section>

      {canManage && !editing && (
        <ActionForm action={deleteDocAction.bind(null, workspaceId, docId)}>
          <ConfirmButton
            title="Delete this doc?"
            message={`"${doc.title}" and its files will be removed for good. Docs kept inside it move to the top of the list. You can't undo this.`}
            confirmLabel="Delete doc"
          >
            Delete doc
          </ConfirmButton>
        </ActionForm>
      )}
    </div>
  );
}
