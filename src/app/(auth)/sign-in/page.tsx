import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { safeNextPath } from "@/lib/env";
import { getOptionalCtx } from "@/server/db/web";
import { signIn } from "../actions";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  if (await getOptionalCtx()) redirect(next);
  return (
    <div className="card p-6">
      <h1 className="h1 mb-5">Sign in</h1>
      <ActionForm action={signIn} className="space-y-4">
        <input type="hidden" name="next" value={next} />
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <button className="btn btn-primary w-full" type="submit">Sign in</button>
      </ActionForm>
      <p className="muted mt-5">
        New here?{" "}
        <Link className="link font-medium" href={`/sign-up?next=${encodeURIComponent(next)}`}>
          Create an account
        </Link>
      </p>
    </div>
  );
}
