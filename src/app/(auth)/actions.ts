"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { type ActionState, run, str } from "@/app/_lib/action";
import { safeNextPath } from "@/lib/env";
import { appUrl, createWebDb, getWebCtx } from "@/server/db/web";
import { Invalid } from "@/server/errors";
import { recordLogin } from "@/server/modules/audit/service";
import { parse } from "@/server/validate";

const credentials = z.object({
  email: z.email("enter a valid email address"),
  password: z.string().min(8, "must be at least 8 characters").max(200),
});

export async function signIn(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { email, password } = parse(credentials, {
      email: str(formData, "email").toLowerCase(),
      password: formData.get("password"),
    });
    const db = await createWebDb();
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error || !data.user) throw new Invalid("Wrong email or password.");
    await recordLogin({ userId: data.user.id, email, db, channel: "web" });
    redirect(safeNextPath(str(formData, "next")));
  });
}

export async function signUp(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(async () => {
    const { email, password } = parse(credentials, {
      email: str(formData, "email").toLowerCase(),
      password: formData.get("password"),
    });
    const displayName = str(formData, "name").slice(0, 80);
    const next = safeNextPath(str(formData, "next"));
    const db = await createWebDb();
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName },
        emailRedirectTo: `${await appUrl()}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (error) throw new Invalid(error.message);
    // With email confirmation switched on there is no session yet.
    if (!data.session) {
      return { ok: true, data: { message: "Check your email to confirm your account, then sign in." } };
    }
    redirect(next);
  });
}

export async function signOut(): Promise<void> {
  const db = await createWebDb();
  await db.auth.signOut();
  redirect("/sign-in");
}

/**
 * Re-enter the password to unlock owner-only actions for 10 minutes.
 * Signing in again issues a session whose authentication time is "now", which
 * both authorize() and the database policies check.
 */
export async function confirmPassword(password: string): Promise<ActionState> {
  return run(async () => {
    const ctx = await getWebCtx();
    const { error } = await ctx.db.auth.signInWithPassword({ email: ctx.email, password });
    if (error) throw new Invalid("Wrong password.");
  });
}
