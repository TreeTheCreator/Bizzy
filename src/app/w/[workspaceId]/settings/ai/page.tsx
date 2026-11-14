import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { NoAccess } from "@/components/no-access";
import { getWebCtx } from "@/server/db/web";
import { type McpPolicy, listWorkspaceConnections } from "@/server/modules/mcp/service";
import { listMembers } from "@/server/modules/members/service";
import { getWorkspace } from "@/server/modules/workspaces/service";
import { revokeMemberConnectionAction, setMcpPolicyAction } from "../actions";
import { SettingsNav } from "../subnav";

export const metadata: Metadata = { title: "AI connections" };

const POLICIES: { value: McpPolicy; label: string; help: string }[] = [
  { value: "off", label: "Off", help: "No AI app can reach this workspace." },
  { value: "read_only", label: "Read only", help: "AI apps can read what the member can see, and change nothing." },
  { value: "read_write", label: "Read and write", help: "AI apps can do what the member's role allows on each page." },
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
      <h1 className="h1 mb-4">AI connections</h1>
      <SettingsNav workspaceId={workspaceId} isOwner={access.isOwner} />

      <section className="card mb-6">
        <h2 className="h2 mb-1">What AI apps may do here</h2>
        <p className="muted mb-3">
          Members can connect AI apps (such as Claude) to Bizzy. An app acts as the member who connected it
          and never gets more than that member&apos;s role. Members, roles and settings are never available to
          AI apps. Members connect and disconnect their own apps under{" "}
          <Link className="text-accent underline" href="/connections">AI connections</Link>.
        </p>
        {access.isOwner ? (
          <ActionForm action={setMcpPolicyAction.bind(null, workspaceId)} className="space-y-2" successMessage="Saved.">
            {POLICIES.map((p) => (
              <label key={p.value} className="flex items-start gap-2">
                <input type="radio" name="policy" value={p.value} defaultChecked={p.value === workspace.mcp_policy} className="mt-1" />
                <span>
                  <span className="font-medium">{p.label}</span>
                  <span className="muted block">{p.help}</span>
                </span>
              </label>
            ))}
            <button className="btn btn-primary" type="submit">Save</button>
          </ActionForm>
        ) : (
          <p>
            <span className="badge">{current.label}</span> <span className="muted">{current.help} Only the owner can change this.</span>
          </p>
        )}
      </section>

      <section className="card overflow-x-auto">
        <h2 className="h2 mb-3">Connected apps</h2>
        {connections.length === 0 ? (
          <p className="muted">No AI apps are connected to this workspace.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Member</th>
                <th>App</th>
                <th>Connected</th>
                <th>Last used</th>
                {access.isOwner && <th />}
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={`${c.user_id}:${c.client_id}`}>
                  <td>{memberName(c.user_id)}</td>
                  <td>{c.client_name || "Unnamed app"}</td>
                  <td>{c.created_at.slice(0, 10)}</td>
                  <td>{c.last_used_at ? c.last_used_at.slice(0, 10) : "Never"}</td>
                  {access.isOwner && (
                    <td>
                      <ActionForm action={revokeMemberConnectionAction.bind(null, workspaceId)}>
                        <input type="hidden" name="userId" value={c.user_id} />
                        <input type="hidden" name="clientId" value={c.client_id} />
                        <button className="btn btn-sm btn-danger" type="submit">Disconnect</button>
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
