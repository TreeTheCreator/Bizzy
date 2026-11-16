import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { getWebCtx } from "@/server/db/web";
import { previewInvite } from "@/server/modules/members/service";
import { acceptInviteAction } from "../../workspaces/actions";

export const metadata: Metadata = { title: "Invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await getWebCtx(`/invite/${token}`);
  const invite = await previewInvite(ctx, token);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="card p-6">
        {!invite || !invite.usable ? (
          <>
            <h1 className="h1 mb-2">This invite no longer works</h1>
            <p className="muted">It may have expired, been used already, or been cancelled. Ask for a new one.</p>
          </>
        ) : invite.email.toLowerCase() !== ctx.email.toLowerCase() ? (
          <>
            <h1 className="h1 mb-2">This invite is for a different email</h1>
            <p className="muted">
              This invite was sent to {invite.email}, but you are signed in as {ctx.email}. Sign out and sign
              in with the invited address.
            </p>
          </>
        ) : (
          <>
            <h1 className="h1 mb-2">Join {invite.workspace_name}</h1>
            <p className="muted mb-4">
              After you join, the owner chooses what you can see. Until they do, the workspace will look
              empty. That is normal.
            </p>
            <ActionForm action={acceptInviteAction}>
              <input type="hidden" name="token" value={token} />
              <button className="btn btn-primary" type="submit">Join {invite.workspace_name}</button>
            </ActionForm>
          </>
        )}
        <p className="mt-5">
          <Link className="link" href="/workspaces">Go to your businesses</Link>
        </p>
      </div>
    </main>
  );
}
