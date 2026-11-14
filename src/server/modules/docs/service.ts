import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authorize } from "@/server/authz/authorize";
import type { Ctx } from "@/server/context";
import { AppError, Invalid, NotFound, unwrap } from "@/server/errors";
import { id, parse } from "@/server/validate";

export const DOC_KINDS = ["doc", "wiki", "sop"] as const;
export const FILE_BUCKET = "workspace-files";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface DocSummary {
  id: string;
  parent_id: string | null;
  kind: (typeof DOC_KINDS)[number];
  title: string;
  updated_at: string;
}

export interface Doc extends DocSummary {
  workspace_id: string;
  content: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
}

export interface FileRow {
  id: string;
  doc_id: string | null;
  name: string;
  storage_path: string;
  size_bytes: number;
  mime_type: string;
  uploaded_by: string | null;
  created_at: string;
}

// Rules without defaults, so partial updates leave unsent fields untouched.
const docRules = z.object({
  title: z.string().trim().min(1, "is required").max(200),
  content: z.string().max(500_000),
  kind: z.enum(DOC_KINDS),
  parentId: id.nullable(),
});
const docFields = docRules.extend({
  content: docRules.shape.content.default(""),
  kind: docRules.shape.kind.default("doc"),
  parentId: docRules.shape.parentId.default(null),
});
export type DocInput = z.input<typeof docFields>;

const FILE_COLUMNS = "id, doc_id, name, storage_path, size_bytes, mime_type, uploaded_by, created_at";

/** All docs in the workspace, without content (for the tree). */
export async function listDocs(ctx: Ctx, workspaceId: string): Promise<DocSummary[]> {
  await authorize(ctx, parse(id, workspaceId), "docs", "view");
  return unwrap<DocSummary[]>(
    await ctx.db
      .from("docs")
      .select("id, parent_id, kind, title, updated_at")
      .eq("workspace_id", workspaceId)
      .order("title")
      .limit(2000),
  );
}

/** Docs whose title or content contains the query (titles only, no content). */
export async function searchDocs(ctx: Ctx, workspaceId: string, query: string): Promise<DocSummary[]> {
  await authorize(ctx, parse(id, workspaceId), "docs", "view");
  // Strip characters that have meaning in PostgREST filters or LIKE patterns.
  const term = String(query).replace(/[%_\\,()*"']/g, " ").trim().slice(0, 100);
  if (term.length < 2) throw new Invalid("query: enter at least 2 characters");
  const pattern = `%${term}%`;
  return unwrap<DocSummary[]>(
    await ctx.db
      .from("docs")
      .select("id, parent_id, kind, title, updated_at")
      .eq("workspace_id", workspaceId)
      .or(`title.ilike.${pattern},content.ilike.${pattern}`)
      .order("updated_at", { ascending: false })
      .limit(25),
  );
}

export async function getDoc(
  ctx: Ctx,
  workspaceId: string,
  docId: string,
): Promise<{ doc: Doc; files: FileRow[] }> {
  await authorize(ctx, parse(id, workspaceId), "docs", "view");
  const doc = unwrap<Doc | null>(
    await ctx.db
      .from("docs")
      .select("id, workspace_id, parent_id, kind, title, content, created_by, updated_by, created_at, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, docId))
      .maybeSingle(),
  );
  if (!doc) throw new NotFound("Doc");
  const files = unwrap<FileRow[]>(
    await ctx.db
      .from("files")
      .select(FILE_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("doc_id", docId)
      .order("created_at"),
  );
  return { doc, files };
}

export async function createDoc(ctx: Ctx, workspaceId: string, input: DocInput): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "docs", "edit");
  const data = parse(docFields, input);
  const row = unwrap<{ id: string }>(
    await ctx.db
      .from("docs")
      .insert({
        workspace_id: workspaceId,
        title: data.title,
        content: data.content,
        kind: data.kind,
        parent_id: data.parentId,
        created_by: ctx.userId,
        updated_by: ctx.userId,
      })
      .select("id")
      .single(),
  );
  return row.id;
}

export async function updateDoc(
  ctx: Ctx,
  workspaceId: string,
  docId: string,
  input: Partial<DocInput>,
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "docs", "edit");
  const data = parse(docRules.partial(), input);
  parse(id, docId);

  if (data.parentId) {
    // Refuse to move a doc underneath itself or one of its own descendants.
    const all = unwrap<{ id: string; parent_id: string | null }[]>(
      await ctx.db.from("docs").select("id, parent_id").eq("workspace_id", workspaceId),
    );
    const parentOf = new Map(all.map((d) => [d.id, d.parent_id]));
    for (let cursor: string | null = data.parentId, hops = 0; cursor; cursor = parentOf.get(cursor) ?? null) {
      if (cursor === docId || ++hops > 2000) throw new Invalid("A doc can't be moved inside itself.");
    }
  }

  const row: Record<string, unknown> = { updated_by: ctx.userId };
  if (data.title !== undefined) row.title = data.title;
  if (data.content !== undefined) row.content = data.content;
  if (data.kind !== undefined) row.kind = data.kind;
  if (data.parentId !== undefined) row.parent_id = data.parentId;
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("docs").update(row).eq("workspace_id", workspaceId).eq("id", docId).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Doc");
}

/** Delete a doc. Child docs move to the top level; attached files are deleted. */
export async function deleteDoc(ctx: Ctx, workspaceId: string, docId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "docs", "manage");
  const files = unwrap<{ id: string; storage_path: string }[]>(
    await ctx.db
      .from("files")
      .select("id, storage_path")
      .eq("workspace_id", workspaceId)
      .eq("doc_id", parse(id, docId)),
  );
  if (files.length > 0) {
    await ctx.db.storage.from(FILE_BUCKET).remove(files.map((f) => f.storage_path));
    unwrap(await ctx.db.from("files").delete().eq("workspace_id", workspaceId).eq("doc_id", docId));
  }
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("docs").delete().eq("workspace_id", workspaceId).eq("id", docId).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Doc");
}

// --- Files ------------------------------------------------------------------

const uploadFields = z.object({
  docId: id.nullable().default(null),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    // Keep the object path boring: no separators or control characters.
    .transform((n) => n.replace(/[^\w.\- ()]/g, "_")),
  sizeBytes: z.number().int().min(1).max(MAX_FILE_BYTES, "file is larger than 25 MB"),
  mimeType: z.string().max(200).default("application/octet-stream"),
});

/** Files in the workspace, optionally only those attached to one doc. */
export async function listFiles(ctx: Ctx, workspaceId: string, docId?: string): Promise<FileRow[]> {
  await authorize(ctx, parse(id, workspaceId), "docs", "view");
  let query = ctx.db.from("files").select(FILE_COLUMNS).eq("workspace_id", workspaceId);
  if (docId) query = query.eq("doc_id", parse(id, docId));
  return unwrap<FileRow[]>(await query.order("created_at", { ascending: false }).limit(500));
}

/**
 * Step 1 of an upload: check permission and hand back a one-time signed upload
 * URL token. The browser then sends the bytes straight to storage, so large
 * files never pass through a serverless function.
 */
export async function createUpload(
  ctx: Ctx,
  workspaceId: string,
  input: z.input<typeof uploadFields>,
): Promise<{ fileId: string; path: string; token: string }> {
  await authorize(ctx, parse(id, workspaceId), "docs", "edit");
  const data = parse(uploadFields, input);
  const fileId = randomUUID();
  const path = `${workspaceId}/${fileId}/${data.name}`;
  const { data: signed, error } = await ctx.db.storage.from(FILE_BUCKET).createSignedUploadUrl(path);
  if (error || !signed) {
    console.error("[storage] createSignedUploadUrl", error?.message);
    throw new AppError("internal", "Could not start the upload.");
  }
  return { fileId, path, token: signed.token };
}

/** Step 2 of an upload: record the file once the bytes are in storage. */
export async function confirmUpload(
  ctx: Ctx,
  workspaceId: string,
  input: z.input<typeof uploadFields> & { fileId: string },
): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "docs", "edit");
  const data = parse(uploadFields, input);
  const fileId = parse(id, input.fileId);
  // The path is rebuilt here, never taken from the client.
  const path = `${workspaceId}/${fileId}/${data.name}`;
  const { data: found, error } = await ctx.db.storage.from(FILE_BUCKET).list(`${workspaceId}/${fileId}`);
  if (error || !found?.some((object) => object.name === data.name)) {
    throw new Invalid("The upload did not finish. Please try again.");
  }
  unwrap(
    await ctx.db.from("files").insert({
      id: fileId,
      workspace_id: workspaceId,
      doc_id: data.docId,
      name: data.name,
      storage_path: path,
      size_bytes: data.sizeBytes,
      mime_type: data.mimeType,
      uploaded_by: ctx.userId,
    }),
  );
  return fileId;
}

/** A download link that works for 60 seconds. */
export async function getDownloadUrl(ctx: Ctx, workspaceId: string, fileId: string): Promise<string> {
  await authorize(ctx, parse(id, workspaceId), "docs", "view");
  const file = unwrap<FileRow | null>(
    await ctx.db
      .from("files")
      .select(FILE_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, fileId))
      .maybeSingle(),
  );
  if (!file) throw new NotFound("File");
  const { data, error } = await ctx.db.storage
    .from(FILE_BUCKET)
    .createSignedUrl(file.storage_path, 60, { download: file.name });
  if (error || !data) throw new NotFound("File");
  return data.signedUrl;
}

export async function deleteFile(ctx: Ctx, workspaceId: string, fileId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "docs", "manage");
  const rows = unwrap<{ storage_path: string }[]>(
    await ctx.db
      .from("files")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("id", parse(id, fileId))
      .select("storage_path"),
  );
  if (rows.length === 0) throw new NotFound("File");
  await ctx.db.storage.from(FILE_BUCKET).remove(rows.map((r) => r.storage_path));
}
