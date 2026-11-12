import { type NextRequest, NextResponse } from "next/server";
import { safeNextPath } from "@/lib/env";
import { createWebDb } from "@/server/db/web";

/** Landing point for the email-confirmation link: swaps the one-time code for a session. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));
  if (code) {
    const db = await createWebDb();
    const { error } = await db.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, request.nextUrl.origin));
  }
  return NextResponse.redirect(new URL("/sign-in", request.nextUrl.origin));
}
