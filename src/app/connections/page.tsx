import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/modal";
import { BackLink } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { appUrl, getWebCtx } from "@/server/db/web";
import { type Connection, listMyConnections } from "@/server/modules/mcp/service";
import { listMyWorkspaces } from "@/server/modules/workspaces/service";
import { revokeMyConnectionAction } from "./actions";

export const metadata: Metadata = { title: "Your AI apps" };

/** The signed-in user's own AI connections, across all their workspaces. */
export default async function ConnectionsPage() {
  const ctx = await getWebCtx("/connections");
  const [connections, workspaces, base] = await Promise.all([
    listMyConnections(ctx),
    listMyWorkspaces(ctx),
    appUrl(),
  ]);
  const workspaceName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "Unknown workspace";
  const byClient = new Map<string, Connection[]>();
  for (const c of connections) byClient.set(c.client_id, [...(byClient.get(c.client_id) ?? []), c]);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <BackLink href="/workspaces">Back to your businesses</BackLink>
      <h1 className="h1 mb-6">Your AI apps</h1>

      <section className="card mb-6">
        <h2 className="h2 mb-1">Connect an AI app</h2>
        <p className="muted mb-2">
          You can let an AI assistant (such as Claude) look things up and do jobs in Bizzy for you. In the
          assistant, add a custom connector and paste this address. It then brings you back here to choose
          which businesses it may reach.
        </p>
        <input readOnly className="input font-mono text-sm" value={`${base}/api/mcp`} aria-label="Address to paste into your AI app" />
      </section>

      {byClient.size === 0 ? (
        <p className="muted">You have not connected any AI apps.</p>
      ) : (
        <ul className="space-y-4">
          {[...byClient.entries()].map(([clientId, rows]) => (
            <li key={clientId} className="card">
              <div className="mb-3 flex items-start justify-between gap-2">
                <h2 className="h2">{rows[0].client_name || "Unnamed app"}</h2>
                <ActionForm action={revokeMyConnectionAction}>
                  <input type="hidden" name="clientId" value={clientId} />
                  <ConfirmButton
                    className="btn btn-sm btn-danger"
                    title={`Disconnect ${rows[0].client_name || "this app"} everywhere?`}
                    message="It stops working in all your businesses right away. You can connect it again later."
                    confirmLabel="Disconnect everywhere"
                  >
                    Disconnect everywhere
                  </ConfirmButton>
                </ActionForm>
              </div>
              <ul>
                {rows.map((c) => (
                  <li key={c.workspace_id} className="row">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{workspaceName(c.workspace_id)}</span>
                      <span className="muted block">
                        Connected {formatDate(c.created_at)} ·{" "}
                        {c.last_used_at ? `last used ${formatDate(c.last_used_at)}` : "never used"}
                      </span>
                    </span>
                    <ActionForm action={revokeMyConnectionAction}>
                      <input type="hidden" name="clientId" value={clientId} />
                      <input type="hidden" name="workspaceId" value={c.workspace_id} />
                      <button className="btn btn-sm" type="submit">Disconnect</button>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
