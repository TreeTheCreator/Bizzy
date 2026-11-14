"use server";

import { type ActionState, run } from "@/app/_lib/action";
import { getWebCtx } from "@/server/db/web";
import { Invalid } from "@/server/errors";
import { connectClient } from "@/server/modules/mcp/service";

// The browser is sent back to the AI client by the form (see consent-form.tsx),
// not by redirect(): desktop clients use custom URL schemes.

export async function approveConsentAction(
  authorizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return run(async () => {
    const ctx = await getWebCtx();
    // The client's identity is read again from the auth server, never from the form.
    const details = await ctx.db.auth.oauth.getAuthorizationDetails(authorizationId);
    if (details.error || !details.data) throw new Invalid("This request has expired. Start again from your AI app.");
    if (!("authorization_id" in details.data)) {
      return { ok: true, data: { redirect: details.data.redirect_url } };
    }
    const workspaceIds = formData.getAll("workspace").filter((v): v is string => typeof v === "string");
    if (workspaceIds.length === 0) throw new Invalid("Choose at least one workspace, or deny the request.");
    // Record the chosen workspaces first: a token without them reaches nothing.
    await connectClient(ctx, {
      clientId: details.data.client.id,
      clientName: details.data.client.name ?? "",
      workspaceIds,
    });
    const approved = await ctx.db.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true });
    if (approved.error || !approved.data) throw new Invalid("Could not approve the connection. Please try again.");
    return { ok: true, data: { redirect: approved.data.redirect_url } };
  });
}

export async function denyConsentAction(
  authorizationId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  return run(async () => {
    const ctx = await getWebCtx();
    const denied = await ctx.db.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
    if (denied.error || !denied.data) throw new Invalid("This request has expired. You can close this page.");
    return { ok: true, data: { redirect: denied.data.redirect_url } };
  });
}
