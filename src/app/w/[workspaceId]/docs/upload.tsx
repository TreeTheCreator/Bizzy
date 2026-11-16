"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { finishUploadAction, startUploadAction } from "./actions";

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * File upload. The server checks permission and issues a one-time signed
 * upload token; the file then goes straight from the browser to storage, so
 * large files never pass through a serverless function.
 */
export function FileUpload({ workspaceId, docId }: { workspaceId: string; docId: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    setMessage(null);
    if (file.size > MAX_BYTES) {
      setMessage({ text: "That file is larger than 25 MB.", error: true });
      input.value = "";
      return;
    }
    setBusy(true);
    try {
      const request = {
        docId,
        name: file.name,
        sizeBytes: file.size,
        mimeType: file.type || "application/octet-stream",
      };
      const started = await startUploadAction(workspaceId, request);
      if (!started.upload) {
        setMessage({ text: started.error ?? "Could not start the upload.", error: true });
        return;
      }
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      );
      const { error } = await supabase.storage
        .from("workspace-files")
        .uploadToSignedUrl(started.upload.path, started.upload.token, file, { contentType: request.mimeType });
      if (error) {
        setMessage({ text: "The upload didn't work. Try again.", error: true });
        return;
      }
      const finished = await finishUploadAction(workspaceId, { ...request, fileId: started.upload.fileId });
      if (finished.error) {
        setMessage({ text: finished.error, error: true });
        return;
      }
      setMessage({ text: `Uploaded ${file.name}.`, error: false });
      router.refresh();
    } finally {
      setBusy(false);
      input.value = "";
    }
  }

  return (
    <div>
      <label className="btn">
        {busy ? "Uploading…" : "Upload a file"}
        <input type="file" className="sr-only" disabled={busy} onChange={onChange} />
      </label>
      <span className="muted ml-3">Up to 25 MB each.</span>
      {message && (
        <p role={message.error ? "alert" : "status"} className={`mt-2 text-[15px] ${message.error ? "text-danger" : "text-ok"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
