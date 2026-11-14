import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { appUrl, getWebCtx } from "@/server/db/web";
import { type Connection, listMyConnections } from "@/server/modules/mcp/service";
import { listMyWorkspaces } from "@/server/modules/workspaces/service";
import { revokeMyConnectionAction } from "./actions";

export const metadata: Metadata = { title: "AI connections" };

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
      <div className="mb-6 flex items-center justify-between">
        <h1 className="h1">AI connections</h1>
        <Link className="btn btn-sm" href="/workspaces">Workspaces</Link>
      </div>

      <section className="card mb-6">
        <h2 className="h2 mb-1">Connect an AI app</h2>
        <p className="muted mb-2">
          In an app that supports MCP connectors, add a custom connector with this address. It will send you
          here to sign in and choose workspaces.
        </p>
        <input readOnly className="input font-mono text-xs" value={`${base}/api/mcp`} aria-label="MCP server address" />
      </section>

      {byClient.size === 0 ? (
        <p className="muted">No AI apps are connected to your account.</p>
      ) : (
        <ul className="space-y-4">
          {[...byClient.entries()].map(([clientId, rows]) => (
            <li key={clientId} className="card">
              <div className="mb-3 flex items-start justify-between gap-2">
                <h2 className="h2">{rows[0].client_name || "Unnamed app"}</h2>
                <ActionForm action={revokeMyConnectionAction}>
                  <input type="hidden" name="clientId" value={clientId} />
                  <button className="btn btn-sm btn-danger" type="submit">Disconnect everywhere</button>
                </ActionForm>
              </div>
              <ul className="space-y-2">
                {rows.map((c) => (
                  <li key={c.workspace_id} className="flex items-center justify-between gap-2 text-sm">
                    <span>
                      <span className="font-medium">{workspaceName(c.workspace_id)}</span>
                      <span className="muted block">
                        Connected {c.created_at.slice(0, 10)} ·{" "}
                        {c.last_used_at ? `last used ${c.last_used_at.slice(0, 10)}` : "never used"}
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
