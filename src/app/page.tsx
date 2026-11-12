import { redirect } from "next/navigation";
import { getWebCtx } from "@/server/db/web";
import { listMyWorkspaces } from "@/server/modules/workspaces/service";

/** Send people to their first workspace, or to the list if they have none. */
export default async function HomePage() {
  const ctx = await getWebCtx();
  const workspaces = await listMyWorkspaces(ctx);
  redirect(workspaces.length === 1 ? `/w/${workspaces[0].id}` : "/workspaces");
}
