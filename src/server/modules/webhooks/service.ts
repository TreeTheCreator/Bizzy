import { isIP } from "node:net";
import { z } from "zod";
import { authorize } from "@/server/authz/authorize";
import type { Ctx } from "@/server/context";
import { NotFound, unwrap } from "@/server/errors";
import { id, parse } from "@/server/validate";
import { isPrivateAddress } from "@/server/webhooks/deliver";

/** Events a webhook can subscribe to. Must match public.webhook_event_page() in the database. */
export const WEBHOOK_EVENTS = [
  "task.created",
  "task.completed",
  "deal.created",
  "deal.stage_changed",
  "deal.won",
  "invoice.sent",
  "invoice.paid",
] as const;

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  created_by: string;
  created_at: string;
  failure_count: number;
  last_delivery_at: string | null;
  last_status: number | null;
}

export interface WebhookDelivery {
  id: number;
  webhook_id: string;
  event: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  response_status: number | null;
  created_at: string;
}

const webhookUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "must be an https:// address")
  // Catch the obvious mistakes when the webhook is added. The delivery worker
  // still checks every address after looking it up, which is the real guard.
  .refine((value) => {
    if (!URL.canParse(value)) return true; // already reported by the check above
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || /\.(localhost|local|internal)$/.test(host)) return false;
    return isIP(host) === 0 || !isPrivateAddress(host);
  }, "must be a public address, not one on this computer or a private network");

/** The workspace's webhooks with their most recent deliveries. Needs Settings manage. */
export async function listWebhooks(
  ctx: Ctx,
  workspaceId: string,
): Promise<{ webhooks: Webhook[]; deliveries: WebhookDelivery[] }> {
  await authorize(ctx, parse(id, workspaceId), "settings", "manage");
  const [webhooks, deliveries] = await Promise.all([
    ctx.db
      .from("webhooks")
      .select("id, url, events, active, created_by, created_at, failure_count, last_delivery_at, last_status")
      .eq("workspace_id", workspaceId)
      .order("created_at"),
    ctx.db
      .from("webhook_deliveries")
      .select("id, webhook_id, event, status, attempts, response_status, created_at")
      .eq("workspace_id", workspaceId)
      .order("id", { ascending: false })
      .limit(30),
  ]);
  return { webhooks: unwrap<Webhook[]>(webhooks), deliveries: unwrap<WebhookDelivery[]>(deliveries) };
}

/**
 * Add a webhook. The caller must be able to see the page behind every chosen
 * event. Returns the signing secret, which is shown once.
 */
export async function createWebhook(
  ctx: Ctx,
  workspaceId: string,
  input: { url: string; events: string[] },
): Promise<{ id: string; secret: string }> {
  await authorize(ctx, parse(id, workspaceId), "settings", "manage");
  const data = parse(
    z.object({ url: webhookUrl, events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "choose at least one event") }),
    input,
  );
  return unwrap<{ id: string; secret: string }>(
    await ctx.db.rpc("webhook_create", { p_workspace: workspaceId, p_url: data.url, p_events: data.events }),
  );
}

/** Pause or resume a webhook. */
export async function setWebhookActive(
  ctx: Ctx,
  workspaceId: string,
  webhookId: string,
  input: { active: boolean },
): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "settings", "manage");
  const { active } = parse(z.object({ active: z.boolean() }), input);
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("webhooks").update({ active }).eq("workspace_id", workspaceId).eq("id", parse(id, webhookId)).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Webhook");
}

export async function deleteWebhook(ctx: Ctx, workspaceId: string, webhookId: string): Promise<void> {
  await authorize(ctx, parse(id, workspaceId), "settings", "manage");
  const rows = unwrap<{ id: string }[]>(
    await ctx.db.from("webhooks").delete().eq("workspace_id", workspaceId).eq("id", parse(id, webhookId)).select("id"),
  );
  if (rows.length === 0) throw new NotFound("Webhook");
}
