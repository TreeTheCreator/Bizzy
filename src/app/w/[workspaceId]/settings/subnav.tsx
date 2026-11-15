import { TabLink } from "@/components/nav";

/**
 * The sections of Settings. Everyday sections come first; the technical ones
 * (letting other apps talk to Bizzy) sit in their own group so they do not
 * get in the way.
 */
export function SettingsNav({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  const base = `/w/${workspaceId}/settings`;
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
      <nav aria-label="Settings" className="tabs">
        <TabLink href={base} exact>General</TabLink>
        <TabLink href={`${base}/members`}>People</TabLink>
        <TabLink href={`${base}/roles`}>Roles</TabLink>
        {/* The activity log is readable by the owner only. */}
        {isOwner && <TabLink href={`${base}/audit`}>Activity log</TabLink>}
      </nav>
      <div className="flex flex-wrap items-center gap-2">
        <span className="muted">Connect other apps:</span>
        <nav aria-label="Connect other apps" className="tabs">
          <TabLink href={`${base}/ai`}>AI apps</TabLink>
          <TabLink href={`${base}/api`}>API keys</TabLink>
          <TabLink href={`${base}/webhooks`}>Webhooks</TabLink>
        </nav>
      </div>
    </div>
  );
}
