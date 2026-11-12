import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { getWebCtx } from "@/server/db/web";
import { listMyWorkspaces } from "@/server/modules/workspaces/service";
import { signOut } from "../(auth)/actions";
import { createWorkspaceAction } from "./actions";

export const metadata: Metadata = { title: "Workspaces" };

export default async function WorkspacesPage() {
  const ctx = await getWebCtx("/workspaces");
  const workspaces = await listMyWorkspaces(ctx);
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="h1">Your workspaces</h1>
        <form action={signOut}>
          <button className="btn btn-sm" type="submit">Sign out</button>
        </form>
      </div>

      {workspaces.length === 0 ? (
        <p className="muted mb-6">
          You don&apos;t have a workspace yet. Create one for your first business below, or open an invite link
          someone sent you.
        </p>
      ) : (
        <ul className="mb-8 space-y-2">
          {workspaces.map((w) => (
            <li key={w.id}>
              <Link href={`/w/${w.id}`} className="card flex items-center justify-between hover:border-accent">
                <span className="font-medium">{w.name}</span>
                {w.owner_id === ctx.userId && <span className="badge">Owner</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <section className="card">
        <h2 className="h2 mb-1">New workspace</h2>
        <p className="muted mb-3">One workspace per business. You become its owner.</p>
        <ActionForm action={createWorkspaceAction} className="flex flex-wrap gap-2">
          <input className="input max-w-xs" name="name" placeholder="Business name" aria-label="Business name" required maxLength={80} />
          <button className="btn btn-primary" type="submit">Create workspace</button>
        </ActionForm>
      </section>
    </main>
  );
}
