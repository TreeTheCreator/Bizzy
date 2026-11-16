"use client";

import { type ReactNode, createContext, useCallback, useId, useRef } from "react";
import { Icon, type IconName } from "./icons";

/** Lets a form inside a pop-up close it once the form has been saved. */
export const ModalCloseContext = createContext<(() => void) | null>(null);

/**
 * A button that opens a pop-up window holding a form (for example "New task").
 * The pop-up closes itself when the form inside it saves.
 */
export function ModalButton({
  label,
  title,
  icon,
  className = "btn btn-primary",
  children,
}: {
  label: ReactNode;
  title: string;
  icon?: IconName;
  className?: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useCallback(() => dialog.current?.close(), []);
  return (
    <>
      <button type="button" className={className} onClick={() => dialog.current?.showModal()}>
        {icon && <Icon name={icon} size={18} />}
        {label}
      </button>
      <dialog ref={dialog} className="dialog" aria-labelledby={titleId}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="h2" id={titleId}>{title}</h2>
          <button type="button" className="btn btn-ghost btn-sm -mr-2 -mt-1" onClick={close} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <ModalCloseContext value={close}>{children}</ModalCloseContext>
      </dialog>
    </>
  );
}

/**
 * A button that asks "are you sure?" before it submits the form it sits in.
 * Use it for anything that deletes or removes.
 */
export function ConfirmButton({
  children,
  title,
  message,
  confirmLabel,
  className = "btn btn-danger",
}: {
  children: ReactNode;
  title: string;
  message: string;
  confirmLabel: string;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  return (
    <>
      <button type="button" ref={trigger} className={className} onClick={() => dialog.current?.showModal()}>
        {children}
      </button>
      <dialog ref={dialog} className="dialog max-w-md text-left" aria-labelledby={titleId}>
        <h2 className="h2 mb-2" id={titleId}>{title}</h2>
        <p className="muted mb-5 whitespace-normal font-normal">{message}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>
            Keep it
          </button>
          <button
            type="button"
            className="btn btn-danger-solid"
            onClick={() => {
              dialog.current?.close();
              trigger.current?.form?.requestSubmit();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}

/** A drop-down that saves as soon as a choice is picked, with no extra button. */
export function AutoSelect({
  children,
  className = "input",
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={className} onChange={(event) => event.currentTarget.form?.requestSubmit()}>
      {children}
    </select>
  );
}
