import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { NoAccess } from "@/components/no-access";
import { authorize } from "@/server/authz/authorize";
import { atLeast } from "@/server/authz/pages";
import { getWebCtx } from "@/server/db/web";
import { DOC_KINDS, getDoc, listDocs } from "@/server/modules/docs/service";
import { deleteDocAction, deleteFileAction, updateDocAction } from "../actions";
import { FileUpload } from "../upload";

export const metadata: Metadata = { title: "Doc" };

const KIND_LABELS: Record<(typeof DOC_KINDS)[number], string> = { doc: "Doc", wiki: "Wiki page", sop: "SOP" };

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
      <p className="mb-3 text-sm">
        <Link className="text-accent underline" href={base}>← Docs</Link>
        {parent && (
          <>
            {" / "}
            <Link className="text-accent underline" href={`${base}/${parent.id}`}>{parent.title}</Link>
          </>
        )}
      </p>

      {editing ? (
        <section className="card mb-6">
          <ActionForm action={updateDocAction.bind(null, workspaceId, docId)} className="space-y-3">
            <div>
              <label className="label" htmlFor="doc-title">Title</label>
              <input className="input" id="doc-title" name="title" defaultValue={doc.title} required maxLength={200} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="doc-kind">Type</label>
                <select className="input" id="doc-kind" name="kind" defaultValue={doc.kind}>
                  {DOC_KINDS.map((kind) => (
                    <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="doc-parent">Inside</label>
                <select className="input" id="doc-parent" name="parentId" defaultValue={doc.parent_id ?? ""}>
                  <option value="">Top level</option>
                  {docs.filter((d) => d.id !== doc.id).map((d) => (
                    <option key={d.id} value={d.id}>{d.title}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="doc-content">Content</label>
              <textarea className="input min-h-96 font-mono" id="doc-content" name="content" defaultValue={doc.content} />
            </div>
            <div className="flex gap-2">
              <button className="btn btn-primary" type="submit">Save</button>
              <Link className="btn" href={`${base}/${docId}`}>Cancel</Link>
            </div>
          </ActionForm>
        </section>
      ) : (
        <article className="card mb-6">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="h1">{doc.title}</h1>
              <p className="muted">
                {KIND_LABELS[doc.kind]} · updated {doc.updated_at.slice(0, 10)}
              </p>
            </div>
            {canEdit && <Link className="btn btn-sm" href={`${base}/${docId}?edit=1`}>Edit</Link>}
          </div>
          {/* Content is rendered as plain text: stored content is data, never markup. */}
          <div className="whitespace-pre-wrap text-sm leading-6">{doc.content || "This doc is empty."}</div>
        </article>
      )}

      <section className="card mb-6">
        <h2 className="h2 mb-3">Files</h2>
        {files.length === 0 && <p className="muted mb-3">No files attached.</p>}
        <ul className="mb-3 space-y-2 text-sm">
          {files.map((file) => (
            <li key={file.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <a className="text-accent underline" href={`/api/files/${workspaceId}/${file.id}`}>{file.name}</a>
                <span className="ml-2 text-muted">{formatBytes(file.size_bytes)}</span>
              </span>
              {canManage && (
                <ActionForm action={deleteFileAction.bind(null, workspaceId)}>
                  <input type="hidden" name="fileId" value={file.id} />
                  <button className="btn btn-sm btn-danger" type="submit">Delete</button>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
        {canEdit && <FileUpload workspaceId={workspaceId} docId={docId} />}
      </section>

      {canManage && !editing && (
        <ActionForm action={deleteDocAction.bind(null, workspaceId, docId)}>
          <button className="btn btn-danger" type="submit">Delete doc</button>
          <span className="muted ml-2">Attached files are deleted too. Pages inside it move to the top level.</span>
        </ActionForm>
      )}
    </div>
  );
}
