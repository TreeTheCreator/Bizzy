import Link from "next/link";

export function SettingsNav({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  const base = `/w/${workspaceId}/settings`;
  const items = [
    { href: base, label: "General" },
    { href: `${base}/members`, label: "Members" },
    { href: `${base}/roles`, label: "Roles" },
    // The audit log is readable by the owner only.
    ...(isOwner ? [{ href: `${base}/audit`, label: "Audit log" }] : []),
  ];
  return (
    <nav aria-label="Settings" className="mb-6 flex flex-wrap gap-2 border-b border-border pb-3 text-sm">
      {items.map((item) => (
        <Link key={item.href} href={item.href} className="rounded px-2 py-1 hover:bg-surface">
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
