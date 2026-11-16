import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { safeNextPath } from "@/lib/env";
import { getOptionalCtx } from "@/server/db/web";
import { signUp } from "../actions";

export const metadata: Metadata = { title: "Create account" };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  if (await getOptionalCtx()) redirect(next);
  return (
    <div className="card p-6">
      <h1 className="h1 mb-5">Create your account</h1>
      <ActionForm action={signUp} className="space-y-4">
        <input type="hidden" name="next" value={next} />
        <div>
          <label className="label" htmlFor="name">Your name</label>
          <input className="input" id="name" name="name" autoComplete="name" required maxLength={80} />
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input className="input" id="password" name="password" type="password" autoComplete="new-password" required minLength={8} />
          <p className="muted mt-1">Use at least 8 characters.</p>
        </div>
        <button className="btn btn-primary w-full" type="submit">Create account</button>
      </ActionForm>
      <p className="muted mt-5">
        Already have an account?{" "}
        <Link className="link font-medium" href={`/sign-in?next=${encodeURIComponent(next)}`}>
          Sign in
        </Link>
      </p>
    </div>
  );
}
