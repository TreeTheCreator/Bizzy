import type { Metadata } from "next";
import { tryLoad } from "@/app/_lib/load";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { ConfirmButton } from "@/components/modal";
import { NoAccess } from "@/components/no-access";
import { PageHeader } from "@/components/ui";
import { humanize } from "@/lib/format";
import { getWebCtx } from "@/server/db/web";
import { WEBHOOK_EVENTS, type Webhook, listWebhooks } from "@/server/modules/webhooks/service";
import { getWorkspace } from "@/server/modules/workspaces/service";
import { createWebhookAction, deleteWebhookAction, setWebhookActiveAction } from "../integration-actions";
import { SettingsNav } from "../subnav";

export const metadata: Metadata = { title: "Webhooks" };

function health(hook: Webhook): { label: string; className: string } {
  if (!hook.active) return { label: hook.failure_count >= 20 ? "Paused after too many failures" : "Paused", className: "pill" };
  if (hook.failure_count > 0) return { label: "Having trouble, retrying", className: "pill pill-danger" };
  if (hook.last_delivery_at) return { label: "Working", className: "pill pill-ok" };
  return { label: "Nothing sent yet", className: "pill" };
}

export default async function WebhooksPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const ctx = await getWebCtx();
  const loaded = await tryLoad(async () => {
    const data = await listWebhooks(ctx, workspaceId); // requires Settings manage
    const { access } = await getWorkspace(ctx, workspaceId);
    return { ...data, access };
  });
  if (loaded.denied) return <NoAccess what="Settings" />;
  const { webhooks, deliveries, access } = loaded.data;
  const delivering = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const hookUrl = (webhookId: string) => webhooks.find((w) => w.id === webhookId)?.url ?? "Deleted webhook";

  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" />
      <SettingsNav workspaceId={workspaceId} isOwner={access.isOwner} />

      {!delivering && (
        <p role="alert" className="mb-6 rounded-xl bg-warn-bg p-4 text-[15px] text-warn">
          Messages aren&apos;t being sent yet. They are saved up and will go out once the person who set up
          Bizzy switches this feature on (<code>SUPABASE_SERVICE_ROLE_KEY</code> is missing; see docs/DEPLOY.md).
        </p>
      )}

      <section className="card mb-6">
        <h2 className="h2 mb-1">Add a webhook</h2>
        <p className="muted mb-3">
          This page is for developers. A webhook tells another app the moment something happens here, by
          sending a message to a web address you choose. You can only pick things from pages your own role
          can see. If nobody asked you for a webhook, you don&apos;t need one.
        </p>
        <ActionForm action={createWebhookAction.bind(null, workspaceId)} className="space-y-4">
          <label className="block">
            <span className="label">Web address to send to</span>
            <input className="input" name="url" type="url" placeholder="https://example.com/hooks/bizzy" required maxLength={2000} />
          </label>
          <fieldset>
            <legend className="label">Send a message when…</legend>
            <div className="grid gap-x-4 sm:grid-cols-2">
              {WEBHOOK_EVENTS.map((event) => (
                <label key={event} className="flex min-h-10 cursor-pointer items-center gap-3">
                  <input type="checkbox" name="events" value={event} />
                  <span>{humanize(event)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button className="btn btn-primary" type="submit">Add webhook</button>
        </ActionForm>
      </section>

      <section className="card mb-6">
        <h2 className="h2 mb-3">Your webhooks</h2>
        {webhooks.length === 0 ? (
          <p className="muted">No webhooks yet.</p>
        ) : (
          <ul>
            {webhooks.map((hook) => {
              const state = health(hook);
              return (
                <li key={hook.id} className="row">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm">{hook.url}</div>
                    <div className="muted">
                      {hook.events.map(humanize).join(", ")}
                      {hook.failure_count > 0 && ` · ${hook.failure_count} failed in a row`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={state.className}>{state.label}</span>
                    <ActionForm action={setWebhookActiveAction.bind(null, workspaceId)}>
                      <input type="hidden" name="webhookId" value={hook.id} />
                      <input type="hidden" name="active" value={String(!hook.active)} />
                      <button className="btn btn-sm" type="submit">{hook.active ? "Pause" : "Resume"}</button>
                    </ActionForm>
                    <ActionForm action={deleteWebhookAction.bind(null, workspaceId)}>
                      <input type="hidden" name="webhookId" value={hook.id} />
                      <ConfirmButton
                        className="btn btn-sm btn-danger"
                        title="Delete this webhook?"
                        message={`Bizzy stops sending messages to ${hook.url}. You can't undo this.`}
                        confirmLabel="Delete webhook"
                      >
                        Delete
                      </ConfirmButton>
                    </ActionForm>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card mb-6 overflow-x-auto">
        <h2 className="h2 mb-3">Messages sent lately</h2>
        {deliveries.length === 0 ? (
          <p className="muted">Nothing has been sent yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>When</th><th>What happened</th><th>Sent to</th><th>Result</th></tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td className="whitespace-nowrap"><LocalTime iso={d.created_at} /></td>
                  <td>{humanize(d.event)}</td>
                  <td className="max-w-48 truncate font-mono text-sm">{hookUrl(d.webhook_id)}</td>
                  <td>
                    {d.status === "delivered" ? "Delivered" : d.status === "failed" ? "Gave up" : d.attempts === 0 ? "Waiting to send" : "Will try again"}
                    {d.response_status ? ` (${d.response_status})` : ""}
                    {d.attempts > 1 && ` · ${d.attempts} tries`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <details className="card">
        <summary className="cursor-pointer font-semibold">Technical details for developers</summary>
        <p className="muted mt-3">
          Every message carries an <code>X-Bizzy-Signature</code> header of the form <code>t=…,v1=…</code>. The{" "}
          <code>v1</code> value is the HMAC-SHA256, in hex, of the <code>t</code> value, a dot, and the raw message
          body, keyed with the webhook&apos;s signing secret. A failed message is retried up to 6 times over about
          half a day; after 20 failures in a row the webhook is paused.
        </p>
      </details>
    </div>
  );
}
