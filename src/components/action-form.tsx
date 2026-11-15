"use client";

import { type ReactNode, startTransition, useActionState, useContext, useEffect, useRef, useState } from "react";
import type { ActionState } from "@/app/_lib/action";
import { confirmPassword } from "@/app/(auth)/actions";
import { ModalCloseContext } from "./modal";

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
  // After a successful save the browser resets the form, and a drop-down then
  // snaps back to the choice it had when the page loaded, even though the new
  // one was saved. Remounting the fields makes them show the saved values.
  const [seenState, setSeenState] = useState(state);
  const [epoch, setEpoch] = useState(0);
  if (state !== seenState) {
    setSeenState(state);
    if (state.ok) setEpoch(epoch + 1);
  }
  const [password, setPassword] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Inside a pop-up: close it once the form has saved, unless the result
  // carries something the person still has to read (a link or a secret).
  const closeModal = useContext(ModalCloseContext);
  useEffect(() => {
    if (state.ok && !state.data?.link && !state.data?.secret) closeModal?.();
  }, [state, closeModal]);

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
      <fieldset key={epoch} disabled={pending} className="contents">
        {children}
      </fieldset>
      {state.error && (
        <p role="alert" className="mt-2 w-full text-[15px] text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (successMessage || state.data?.message) && (
        <p role="status" className="mt-2 w-full text-[15px] text-ok">
          {state.data?.message ?? successMessage}
        </p>
      )}
      {state.ok && state.data?.link && (
        <div className="mt-2 w-full text-[15px]">
          <p className="text-ok">Invite created. Copy this link and send it to them. It is shown only once.</p>
          <input readOnly className="input mt-1 font-mono text-sm" value={state.data.link} onFocus={(e) => e.target.select()} />
        </div>
      )}
      {state.ok && state.data?.secret && (
        <div className="mt-2 w-full text-[15px]">
          <p className="text-ok">{state.data.secretNote ?? "Copy this now. It is shown only once."}</p>
          <input readOnly className="input mt-1 font-mono text-sm" value={state.data.secret} aria-label="Secret" onFocus={(e) => e.target.select()} />
        </div>
      )}
      {state.reauth && (
        <div className="mt-3 w-full rounded-lg border border-border p-4 text-left">
          <p className="font-medium">Enter your password to continue</p>
          <p className="muted">This is a big change, so we check it is really you.</p>
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
          {confirmError && <p className="mt-1 text-[15px] text-danger">{confirmError}</p>}
        </div>
      )}
    </form>
  );
}
