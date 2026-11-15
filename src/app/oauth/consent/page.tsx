import type { Metadata } from "next";
import Link from "next/link";
import { getWebCtx } from "@/server/db/web";
import { listMyWorkspaces } from "@/server/modules/workspaces/service";
import { approveConsentAction, denyConsentAction } from "./actions";
import { ConsentForm, GoTo } from "./consent-form";

export const metadata: Metadata = { title: "Connect an AI app" };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <p className="mb-6 text-3xl font-semibold">Bizzy</p>
      <div className="card p-6">{children}</div>
    </main>
  );
}

/**
 * The consent screen an AI app (an MCP client) sends the user to. Supabase
 * Auth runs the OAuth flow; this page shows who is asking and lets the user
 * choose which workspaces the app may reach.
 */
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string }>;
}) {
  const authorizationId = (await searchParams).authorization_id ?? "";
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(authorizationId)) {
    return (
      <Shell>
        <h1 className="h1 mb-2">Nothing to approve</h1>
        <p className="muted">Open this page from your AI app&apos;s &quot;connect&quot; step.</p>
      </Shell>
    );
  }
  const ctx = await getWebCtx(`/oauth/consent?authorization_id=${authorizationId}`);
  const { data, error } = await ctx.db.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error || !data) {
    return (
      <Shell>
        <h1 className="h1 mb-2">This request has expired</h1>
        <p className="muted">Go back to your AI app and start connecting again.</p>
      </Shell>
    );
  }
  // Already approved for this app earlier: the auth server sends it straight back.
  if (!("authorization_id" in data)) {
    return (
      <Shell>
        <GoTo url={data.redirect_url} />
      </Shell>
    );
  }

  const workspaces = await listMyWorkspaces(ctx);
  let returnsTo = data.redirect_uri;
  try {
    returnsTo = new URL(data.redirect_uri).host || data.redirect_uri;
  } catch {
    // Show the raw value if it is not a normal URL.
  }

  return (
    <Shell>
      <h1 className="h1 mb-2">Connect {data.client.name || "an AI app"} to Bizzy?</h1>
      <p className="muted mb-1">
        Signed in as {ctx.email}. After you choose, you return to <span className="font-mono">{returnsTo}</span>.
        Only allow this if you started it yourself.
      </p>
      <p className="muted mb-4">
        The app can do what you can do, and no more. It can never change people, roles or settings. You can
        disconnect it at any time under{" "}
        <Link className="link" href="/connections">Your AI apps</Link>.
      </p>
      {workspaces.length === 0 ? (
        <p className="muted">You are not a member of any workspace yet, so there is nothing to connect.</p>
      ) : (
        <ConsentForm
          approve={approveConsentAction.bind(null, authorizationId)}
          deny={denyConsentAction.bind(null, authorizationId)}
          workspaces={workspaces.map((w) => ({ id: w.id, name: w.name, policy: w.mcp_policy }))}
        />
      )}
    </Shell>
  );
}
