import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { getWebCtx } from "@/server/db/web";
import { type McpPolicy, listWorkspaceConnections } from "@/server/modules/mcp/service";
import { listMembers } from "@/server/modules/members/service";
import { getWorkspace } from "@/server/modules/workspaces/service";
import { revokeMemberConnectionAction, setMcpPolicyAction } from "../actions";
import { SettingsNav } from "../subnav";

export const metadata: Metadata = { title: "AI apps" };

const POLICIES: { value: McpPolicy; label: string; help: string }[] = [
  { value: "off", label: "Nothing", help: "No AI app can reach this workspace." },
  { value: "read_only", label: "Look only", help: "AI apps can read what the person can see, and change nothing." },
  { value: "read_write", label: "Look and make changes", help: "AI apps can do whatever the person's own role allows." },
];

export default async function AiSettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ctx = await getWebCtx();
  const loaded = await tryLoad(async () => {
    const connections = await listWorkspaceConnections(ctx, workspaceId); // requires Settings manage
    const [members, { workspace, access }] = await Promise.all([
      listMembers(ctx, workspaceId),
      getWorkspace(ctx, workspaceId),
    ]);
    return { connections, members, workspace, access };
  });
  if (loaded.denied) return <NoAccess what="Settings" />;
  const { connections, members, workspace, access } = loaded.data;
  const memberName = (userId: string) => members.find((m) => m.user_id === userId)?.display_name ?? "Former member";
  const current = POLICIES.find((p) => p.value === workspace.mcp_policy) ?? POLICIES[0];

  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" />
      <SettingsNav workspaceId={workspaceId} isOwner={access.isOwner} />

      <section className="card mb-6">
        <h2 className="h2 mb-1">What AI apps may do here</h2>
        <p className="muted mb-3">
          People here can connect an AI assistant (such as Claude) to Bizzy, so it can look things up or
          do jobs for them. The assistant never sees more than the person who connected it, and can never
          touch people, roles or settings. Each person connects and disconnects their own apps under{" "}
          <Link className="link" href="/connections">Your AI apps</Link>.
        </p>
        {access.isOwner ? (
          <ActionForm action={setMcpPolicyAction.bind(null, workspaceId)} className="space-y-3" successMessage="Saved.">
            {POLICIES.map((p) => (
              <label key={p.value} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-checked:border-accent has-checked:bg-accent-bg">
                <input type="radio" name="policy" value={p.value} defaultChecked={p.value === workspace.mcp_policy} className="mt-1" />
                <span>
                  <span className="font-medium">{p.label}</span>
                  <span className="muted block">{p.help}</span>
                </span>
              </label>
            ))}
            <button className="btn btn-primary" type="submit">Save choice</button>
          </ActionForm>
        ) : (
          <p>
            <span className="pill pill-info">{current.label}</span> <span className="muted">{current.help} Only the owner can change this.</span>
          </p>
        )}
      </section>

      <section className="card overflow-x-auto">
        <h2 className="h2 mb-3">Apps connected right now</h2>
        {connections.length === 0 ? (
          <p className="muted">No AI apps are connected.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Person</th>
                <th>App</th>
                <th>Connected</th>
                <th>Last used</th>
                {access.isOwner && <th><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={`${c.user_id}:${c.client_id}`}>
                  <td>{memberName(c.user_id)}</td>
                  <td>{c.client_name || "Unnamed app"}</td>
                  <td>{formatDate(c.created_at)}</td>
                  <td>{c.last_used_at ? formatDate(c.last_used_at) : "Never"}</td>
                  {access.isOwner && (
                    <td>
                      <ActionForm action={revokeMemberConnectionAction.bind(null, workspaceId)}>
                        <input type="hidden" name="userId" value={c.user_id} />
                        <input type="hidden" name="clientId" value={c.client_id} />
                        <ConfirmButton
                          className="btn btn-sm btn-danger"
                          title={`Disconnect ${c.client_name || "this app"}?`}
                          message={`It stops working for ${memberName(c.user_id)} in this workspace right away. They can connect it again later.`}
                          confirmLabel="Disconnect"
                        >
                          Disconnect
                        </ConfirmButton>
                      </ActionForm>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
