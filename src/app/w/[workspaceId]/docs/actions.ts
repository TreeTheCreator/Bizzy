"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionState, run, str, strOrNull } from "@/app/_lib/action";
import { getWebCtx } from "@/server/db/web";
import {
  type DocInput,
  confirmUpload,
  createDoc,
  createUpload,
  deleteDoc,
  deleteFile,
  updateDoc,
} from "@/server/modules/docs/service";

// Permission checks live in the service functions; these only translate forms.

function refresh(workspaceId: string) {
  revalidatePath(`/w/${workspaceId}`, "layout");
}

export async function createDocAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    const docId = await createDoc(await getWebCtx(), workspaceId, {
      title: str(formData, "title"),
      kind: (str(formData, "kind") || "doc") as DocInput["kind"],
      parentId: strOrNull(formData, "parentId"),
    });
    refresh(workspaceId);
    redirect(`/w/${workspaceId}/docs/${docId}?edit=1`);
  });
}

export async function updateDocAction(workspaceId: string, docId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await updateDoc(await getWebCtx(), workspaceId, docId, {
      title: str(formData, "title"),
      // Content is not trimmed: leading/trailing whitespace can be meaningful.
      content: typeof formData.get("content") === "string" ? (formData.get("content") as string) : "",
      kind: (str(formData, "kind") || "doc") as DocInput["kind"],
      parentId: strOrNull(formData, "parentId"),
    });
    refresh(workspaceId);
    redirect(`/w/${workspaceId}/docs/${docId}`);
  });
}

export async function deleteDocAction(workspaceId: string, docId: string, _prev: ActionState, _formData: FormData) {
  return run(async () => {
    await deleteDoc(await getWebCtx(), workspaceId, docId);
    refresh(workspaceId);
    redirect(`/w/${workspaceId}/docs`);
  });
}

export async function deleteFileAction(workspaceId: string, _prev: ActionState, formData: FormData) {
  return run(async () => {
    await deleteFile(await getWebCtx(), workspaceId, str(formData, "fileId"));
    refresh(workspaceId);
  });
}

interface UploadRequest {
  docId: string | null;
  name: string;
  sizeBytes: number;
  mimeType: string;
}

/** Upload step 1 (called from the browser): permission check + one-time upload token. */
export async function startUploadAction(
  workspaceId: string,
  request: UploadRequest,
): Promise<ActionState & { upload?: { fileId: string; path: string; token: string } }> {
  let upload: { fileId: string; path: string; token: string } | undefined;
  const state = await run(async () => {
    upload = await createUpload(await getWebCtx(), workspaceId, request);
  });
  return { ...state, upload };
}

/** Upload step 2: record the file after the bytes reached storage. */
export async function finishUploadAction(
  workspaceId: string,
  request: UploadRequest & { fileId: string },
): Promise<ActionState> {
  return run(async () => {
    await confirmUpload(await getWebCtx(), workspaceId, request);
    refresh(workspaceId);
  });
}
