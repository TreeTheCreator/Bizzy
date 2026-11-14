"use client";

import { useActionState, useEffect } from "react";
import type { ActionState } from "@/app/_lib/action";

type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

interface WorkspaceOption {
  id: string;
  name: string;
  policy: "off" | "read_only" | "read_write";
}

const POLICY_NOTE: Record<WorkspaceOption["policy"], string> = {
  off: "AI access is switched off by the owner",
  read_only: "Read only",
  read_write: "Can read and make changes",
};

/** Sends the browser back to the AI client once an action returns its URL. */
export function GoTo({ url }: { url: string }) {
  useEffect(() => {
    window.location.assign(url);
  }, [url]);
  return (
    <p className="muted">
      Returning to your AI app… <a className="text-accent underline" href={url}>Continue</a> if nothing happens.
    </p>
  );
}

export function ConsentForm({
  approve,
  deny,
  workspaces,
}: {
  approve: FormAction;
  deny: FormAction;
  workspaces: WorkspaceOption[];
}) {
  const [approved, approveDispatch, approving] = useActionState(approve, {});
  const [denied, denyDispatch, denying] = useActionState(deny, {});
  const redirect = approved.data?.redirect ?? denied.data?.redirect;
  if (redirect) return <GoTo url={redirect} />;
  const error = approved.error ?? denied.error;
  const busy = approving || denying;

  return (
    <form action={approveDispatch}>
      <fieldset disabled={busy} className="space-y-2">
        <legend className="label">Workspaces it may reach</legend>
        {workspaces.map((w) => (
          <label key={w.id} className="flex items-start gap-2 rounded-md border border-border p-2">
            <input type="checkbox" name="workspace" value={w.id} className="mt-1" />
            <span>
              <span className="font-medium">{w.name}</span>
              <span className="muted block">{POLICY_NOTE[w.policy]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {approving ? "Connecting…" : "Allow"}
        </button>
        <button className="btn" type="submit" formAction={denyDispatch} disabled={busy}>
          Deny
        </button>
      </div>
    </form>
  );
}
