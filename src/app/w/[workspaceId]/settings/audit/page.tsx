import type { Metadata } from "next";
import Link from "next/link";
import { tryLoad } from "@/app/_lib/load";
import { NoAccess } from "@/components/no-access";
import { getWebCtx } from "@/server/db/web";
import { listAudit } from "@/server/modules/audit/service";
import { listMembers } from "@/server/modules/members/service";
import { SettingsNav } from "../subnav";

export const metadata: Metadata = { title: "Audit log" };

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
    const members = await listMembers(ctx, workspaceId);
    return { entries, members };
  });
  if (loaded.denied) return <NoAccess what="the audit log" />;
  const { entries, members } = loaded.data;
  const who = (userId: string | null) =>
    members.find((m) => m.user_id === userId)?.display_name ?? (userId ? "Former member" : "System");
  const last = entries.at(-1);

  return (
    <div className="max-w-5xl">
      <h1 className="h1 mb-4">Audit log</h1>
      <SettingsNav workspaceId={workspaceId} isOwner />
      <p className="muted mb-4">
        Sign-ins, role and member changes, invites and refused actions. Entries cannot be edited or deleted.
      </p>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>When (UTC)</th>
              <th>Who</th>
              <th>Event</th>
              <th>Target</th>
              <th>Via</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className="whitespace-nowrap font-mono text-xs">{entry.created_at.slice(0, 19).replace("T", " ")}</td>
                <td>{who(entry.actor_id)}</td>
                <td className="font-mono text-xs">{entry.event}</td>
                <td className="text-xs">
                  {/* Targets that are user ids are shown as names. */}
                  {members.find((m) => m.user_id === entry.target)?.display_name ?? entry.target ?? ""}
                </td>
                <td>{entry.channel}</td>
                <td className={entry.outcome === "ok" ? "" : "text-danger"}>{entry.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && <p className="muted p-2">No entries.</p>}
      </div>
      {entries.length === 100 && last && (
        <p className="mt-3 text-sm">
          <Link className="text-accent underline" href={`/w/${workspaceId}/settings/audit?before=${last.id}`}>
            Older entries
          </Link>
        </p>
      )}
    </div>
  );
}
