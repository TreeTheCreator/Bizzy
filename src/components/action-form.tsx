"use client";

import { type ReactNode, startTransition, useActionState, useRef, useState } from "react";
import type { ActionState } from "@/app/_lib/action";
import { confirmPassword } from "@/app/(auth)/actions";

type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * A form wired to a server action. Shows the action's error or success
 * message, and when the action needs a fresh password confirmation (owner-only
 * changes), asks for the password and retries the same submission.
 */
export function ActionForm({
  action,
  children,
  className,
  successMessage,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  successMessage?: string;
}) {
  const lastSubmission = useRef<FormData | null>(null);
  const [state, dispatch, pending] = useActionState(async (prev: ActionState, formData: FormData) => {
    lastSubmission.current = formData;
    return action(prev, formData);
  }, {});
  const [password, setPassword] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function confirmAndRetry() {
    setConfirming(true);
    setConfirmError(null);
    const result = await confirmPassword(password);
    setConfirming(false);
    if (result.error) {
      setConfirmError(result.error);
      return;
    }
    setPassword("");
    const formData = lastSubmission.current;
    if (formData) startTransition(() => dispatch(formData));
  }

  return (
    <form action={dispatch} className={className}>
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      {state.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (successMessage || state.data?.message) && (
        <p role="status" className="mt-2 text-sm text-ok">
          {state.data?.message ?? successMessage}
        </p>
      )}
      {state.ok && state.data?.link && (
        <div className="mt-2 text-sm">
          <p className="text-ok">Invite created. Copy this link and send it to them. It is shown only once.</p>
          <input readOnly className="input mt-1 font-mono text-xs" value={state.data.link} onFocus={(e) => e.target.select()} />
        </div>
      )}
      {state.reauth && (
        <div className="mt-3 rounded-md border border-border p-3">
          <p className="text-sm font-medium">Confirm your password to continue</p>
          <p className="muted">Owner-only changes need a fresh confirmation.</p>
          <div className="mt-2 flex gap-2">
            <input
              type="password"
              autoComplete="current-password"
              aria-label="Password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void confirmAndRetry();
                }
              }}
            />
            <button type="button" className="btn btn-primary" disabled={confirming || !password} onClick={confirmAndRetry}>
              {confirming ? "Checking…" : "Confirm"}
            </button>
          </div>
          {confirmError && <p className="mt-1 text-sm text-danger">{confirmError}</p>}
        </div>
      )}
    </form>
  );
}
