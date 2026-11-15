import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
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
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="h1">Your businesses</h1>
        <div className="flex gap-2">
          <Link className="btn btn-ghost btn-sm" href="/connections">Your AI apps</Link>
          <form action={signOut}>
            <button className="btn btn-sm" type="submit">Sign out</button>
          </form>
        </div>
      </div>

      {workspaces.length === 0 ? (
        <p className="muted mb-6">
          Welcome! Type the name of your business below to get started. If someone sent you an invite link,
          open that link instead.
        </p>
      ) : (
        <ul className="mb-8 space-y-3">
          {workspaces.map((w) => (
            <li key={w.id}>
              <Link href={`/w/${w.id}`} className="card flex items-center gap-3 hover:border-accent">
                <span className="min-w-0 flex-1 truncate text-lg font-semibold">{w.name}</span>
                {w.owner_id === ctx.userId && <span className="pill pill-info">Owner</span>}
                <Icon name="back" className="rotate-180 text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <section className="card">
        <h2 className="h2 mb-1">{workspaces.length === 0 ? "Set up your business" : "Add another business"}</h2>
        <p className="muted mb-3">Each business gets its own separate space. You will be its owner.</p>
        <ActionForm action={createWorkspaceAction} className="flex flex-wrap gap-2">
          <input className="input max-w-xs" name="name" placeholder="Business name" aria-label="Business name" required maxLength={80} />
          <button className="btn btn-primary" type="submit">{workspaces.length === 0 ? "Get started" : "Add business"}</button>
        </ActionForm>
      </section>
    </main>
  );
}
