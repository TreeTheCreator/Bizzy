import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { LocalTime } from "@/components/local-time";
import { NoAccess } from "@/components/no-access";
import { PageHeader } from "@/components/ui";
import { humanize } from "@/lib/format";
import { getWebCtx } from "@/server/db/web";
import { listAudit } from "@/server/modules/audit/service";
import { listMembers } from "@/server/modules/members/service";
import { listRoles } from "@/server/modules/roles/service";
import { SettingsNav } from "../subnav";

export const metadata: Metadata = { title: "Activity log" };

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const { workspaceId } = await params;
  const before = Number((await searchParams).before) || undefined;
  const ctx = await getWebCtx();
  const loaded = await tryLoad(async () => {
    const entries = await listAudit(ctx, workspaceId, { beforeId: before, limit: 100 }); // owner only
    const [members, roles] = await Promise.all([listMembers(ctx, workspaceId), listRoles(ctx, workspaceId)]);
    return { entries, members, roles };
  });
  if (loaded.denied) return <NoAccess what="the activity log" />;
  const { entries, members, roles } = loaded.data;
  // Targets are stored as ids; show the member or role name instead. A deleted
  // role falls back to the name recorded in the entry itself.
  const targetLabel = (entry: (typeof entries)[number]) =>
    members.find((m) => m.user_id === entry.target)?.display_name ??
    roles.find((r) => r.id === entry.target)?.name ??
    (entry.event.startsWith("role.") && typeof entry.summary.name === "string" ? entry.summary.name : null) ??
    (entry.event === "workspace.created" ? "" : (entry.target ?? ""));
  const detail = (entry: (typeof entries)[number]) => {
    const s = entry.summary;
    if (entry.event.startsWith("role.permission") && s.page) return `${s.page}: ${s.level ?? "removed"}`;
    if (entry.event === "role.assigned" || entry.event === "role.revoked") {
      const name = (id: unknown) => roles.find((r) => r.id === id)?.name ?? (id ? "a deleted role" : "no role");
      return `${name(s.from_role)} → ${name(s.to_role)}`;
    }
    return "";
  };
  const who = (userId: string | null) =>
    members.find((m) => m.user_id === userId)?.display_name ?? (userId ? "Former member" : "System");
  const last = entries.at(-1);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Settings" />
      <SettingsNav workspaceId={workspaceId} isOwner />
      <p className="muted mb-4">
        A record of who signed in, who changed roles or people, invites, and anything that was blocked.
        Nobody can change or delete these entries.
      </p>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What happened</th>
              <th>To whom or what</th>
              <th>Through</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className="whitespace-nowrap"><LocalTime iso={entry.created_at} /></td>
                <td>{who(entry.actor_id)}</td>
                <td>{humanize(entry.event)}</td>
                <td>
                  {targetLabel(entry)}
                  {detail(entry) && <span className="ml-2 text-muted">{detail(entry)}</span>}
                </td>
                <td>{humanize(entry.channel)}</td>
                <td>
                  <span className={entry.outcome === "ok" ? "pill pill-ok" : "pill pill-danger"}>{entry.outcome === "ok" ? "Done" : humanize(entry.outcome)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && <p className="muted p-2">Nothing has been recorded yet.</p>}
      </div>
      {entries.length === 100 && last && (
        <p className="mt-3">
          <Link className="link" href={`/w/${workspaceId}/settings/audit?before=${last.id}`}>
            Show older entries
          </Link>
        </p>
      )}
    </div>
  );
}
