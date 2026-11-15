import type { Metadata } from "next";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { apiEnabled } from "@/server/db/apikey";
import { appUrl, getWebCtx } from "@/server/db/web";
import { listApiKeys } from "@/server/modules/apikeys/service";
import { listMembers } from "@/server/modules/members/service";
import { getWorkspace } from "@/server/modules/workspaces/service";
import { createApiKeyAction, revokeApiKeyAction } from "../integration-actions";
import { SettingsNav } from "../subnav";

export const metadata: Metadata = { title: "API keys" };

export default async function ApiKeysPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ctx = await getWebCtx();
  const loaded = await tryLoad(async () => {
    const keys = await listApiKeys(ctx, workspaceId); // requires Settings manage
    const [members, { access }, base] = await Promise.all([
      listMembers(ctx, workspaceId),
      getWorkspace(ctx, workspaceId),
      appUrl(),
    ]);
    return { keys, members, access, base };
  });
  if (loaded.denied) return <NoAccess what="Settings" />;
  const { keys, members, access, base } = loaded.data;
  const memberName = (userId: string) => members.find((m) => m.user_id === userId)?.display_name ?? "Former member";

  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" />
      <SettingsNav workspaceId={workspaceId} isOwner={access.isOwner} />

      {!apiEnabled() && (
        <p role="alert" className="mb-6 rounded-xl bg-warn-bg p-4 text-[15px] text-warn">
          Keys don&apos;t work yet. You can create them, but the person who set up Bizzy still has to switch
          this feature on (<code>SUPABASE_JWT_SECRET</code> is missing; see docs/DEPLOY.md).
        </p>
      )}

      <section className="card mb-6">
        <h2 className="h2 mb-1">Create a key</h2>
        <p className="muted mb-3">
          This page is for developers. A key is like a password that lets another program read or change
          things here as if it were you. It can never do more than your own role, and never touches people,
          roles or settings. If nobody asked you for a key, you don&apos;t need one.
        </p>
        <ActionForm action={createApiKeyAction.bind(null, workspaceId)} className="flex flex-wrap items-end gap-3">
          <label>
            <span className="label">What is it for?</span>
            <input className="input" name="name" placeholder="Reporting script" required maxLength={80} />
          </label>
          <label>
            <span className="label">It can</span>
            <select className="input" name="scope" defaultValue="read">
              <option value="read">Look only</option>
              <option value="write">Look and make changes</option>
            </select>
          </label>
          <button className="btn btn-primary" type="submit">Create key</button>
        </ActionForm>
      </section>

      <section className="card mb-6 overflow-x-auto">
        <h2 className="h2 mb-3">Keys in use</h2>
        {keys.length === 0 ? (
          <p className="muted">No keys have been created.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Starts with</th><th>It can</th><th>Acts as</th><th>Last used</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td className="font-medium">{key.name}</td>
                  <td className="font-mono text-sm">{key.prefix}…</td>
                  <td>{key.scope === "write" ? "Look and make changes" : "Look only"}</td>
                  <td>{memberName(key.user_id)}</td>
                  <td>{key.last_used_at ? formatDate(key.last_used_at) : "Never"}</td>
                  <td className="text-right">
                    <ActionForm action={revokeApiKeyAction.bind(null, workspaceId)}>
                      <input type="hidden" name="keyId" value={key.id} />
                      <ConfirmButton
                        className="btn btn-sm btn-danger"
                        title={`Switch off the key "${key.name}"?`}
                        message="Anything using this key stops working right away. You can't switch it back on, only create a new key."
                        confirmLabel="Switch off key"
                      >
                        Switch off
                      </ConfirmButton>
                    </ActionForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <details className="card">
        <summary className="cursor-pointer font-semibold">Technical details for developers</summary>
        <p className="muted mb-2 mt-3">Send the key as a Bearer token. Responses are JSON.</p>
        <pre className="overflow-x-auto rounded-lg border border-border p-3 text-sm">
          {`curl ${base}/api/v1/tasks -H "Authorization: Bearer YOUR_KEY"`}
        </pre>
        <p className="muted mt-2">
          Endpoints: workspace, tasks, projects, companies, contacts, deals, deal-stages, invoices, expenses,
          cash-flow. Lists use GET, new items POST, changes PATCH /name/id, removal DELETE /name/id. Up to 120
          reads and 60 changes a minute per key.
        </p>
      </details>
    </div>
  );
}
