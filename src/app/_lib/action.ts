import { unstable_rethrow } from "next/navigation";
import { AppError, ReauthRequired } from "@/server/errors";

/** What every form action returns to the browser. */
export interface ActionState {
  ok?: boolean;
  error?: string;
  /** The action needs a fresh password confirmation before it can run. */
  reauth?: boolean;
  /** Optional values to show after success (e.g. a new invite link). */
  data?: Record<string, string>;
}

/** Run a server action body and turn service errors into form state. */
export async function run(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    return (await fn()) ?? { ok: true };
  } catch (error) {
    unstable_rethrow(error); // let redirect() / notFound() through
    if (error instanceof ReauthRequired) return { reauth: true };
    if (error instanceof AppError) return { error: error.message };
    console.error("[action]", error);
    return { error: "Something went wrong." };
  }
}

/** Read a trimmed string field; empty becomes "". */
export function str(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** Read an optional field; empty becomes null. */
export function strOrNull(formData: FormData, key: string): string | null {
  return str(formData, key) || null;
}
