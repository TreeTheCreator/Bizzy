import { randomBytes } from "node:crypto";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import pg from "pg";
import { expect } from "vitest";
import type { Level, Page } from "@/server/authz/pages";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/errors";
import { acceptInvite, createInvite, setMemberRole } from "@/server/modules/members/service";
import { createRole } from "@/server/modules/roles/service";
import { createWorkspace } from "@/server/modules/workspaces/service";

const url = () => process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let adminClient: SupabaseClient | null = null;
/** Service-role client. Used ONLY to create and clean up test users. */
export function admin(): SupabaseClient {
  adminClient ??= createClient(url(), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminClient;
}

export interface TestUser extends Ctx {
  password: string;
}

const createdUsers: string[] = [];
const createdWorkspaces: string[] = [];

/** Create a real auth user and sign in, returning a service-layer context for them. */
export async function createUser(label: string): Promise<TestUser> {
  const email = `${label}-${randomBytes(6).toString("hex")}@test.bizzy.local`;
  const password = `pw-${randomBytes(12).toString("hex")}`;
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: label },
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  createdUsers.push(data.user.id);
  const db = await signIn(email, password);
  return { userId: data.user.id, email, db, channel: "web", password };
}

/** A fresh signed-in client (fresh login = "recently authenticated"). */
export async function signIn(email: string, password: string): Promise<SupabaseClient> {
  const db = createClient(url(), anonKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn failed: ${error.message}`);
  return db;
}

/** A signed-out client (the public anon key only). */
export function anonClient(): SupabaseClient {
  return createClient(url(), anonKey(), { auth: { persistSession: false, autoRefreshToken: false } });
}

export type Permissions = Partial<Record<Page, { level: Level; sensitive?: boolean }>>;

export interface Team {
  workspaceId: string;
  owner: TestUser;
  /** Built-in Full Access role holder (the "co-founder"). */
  full: TestUser;
  /** Custom role: Tasks edit, Docs view. */
  sales: TestUser;
  /** Custom role: Docs manage only. */
  writer: TestUser;
  /** Guest role: Docs view only. */
  guest: TestUser;
  /** Accepted an invite but was never given a role. */
  norole: TestUser;
  roles: { fullAccess: string; sales: string; writer: string; guest: string };
}

async function join(owner: TestUser, workspaceId: string, user: TestUser): Promise<void> {
  const { token } = await createInvite(owner, workspaceId, { email: user.email });
  await acceptInvite(user, token);
}

/** A workspace with one member of each kind. */
export async function createTeam(name = "Acme"): Promise<Team> {
  const [owner, full, sales, writer, guest, norole] = await Promise.all(
    ["owner", "full", "sales", "writer", "guest", "norole"].map(createUser),
  );
  const workspaceId = await createWorkspace(owner, { name: `${name} ${randomBytes(3).toString("hex")}` });
  createdWorkspaces.push(workspaceId);
  for (const user of [full, sales, writer, guest, norole]) await join(owner, workspaceId, user);

  const { data: builtin } = await owner.db
    .from("roles")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "full_access")
    .single();
  const roles = {
    fullAccess: builtin!.id as string,
    sales: await createRole(owner, workspaceId, {
      name: "Sales",
      kind: "custom",
      permissions: { tasks: { level: "edit" }, docs: { level: "view" } },
    }),
    writer: await createRole(owner, workspaceId, {
      name: "Writer",
      kind: "custom",
      permissions: { docs: { level: "manage" } },
    }),
    guest: await createRole(owner, workspaceId, {
      name: "Guest accountant",
      kind: "guest",
      permissions: { docs: { level: "view" } },
    }),
  };
  await setMemberRole(owner, workspaceId, { userId: full.userId, roleId: roles.fullAccess });
  await setMemberRole(owner, workspaceId, { userId: sales.userId, roleId: roles.sales });
  await setMemberRole(owner, workspaceId, { userId: writer.userId, roleId: roles.writer });
  await setMemberRole(owner, workspaceId, { userId: guest.userId, roleId: roles.guest });
  return { workspaceId, owner, full, sales, writer, guest, norole, roles };
}

/** Delete everything the tests created. */
export async function cleanup(): Promise<void> {
  const sql = await pgClient();
  try {
    if (createdWorkspaces.length > 0) {
      await sql.query("delete from public.workspaces where id = any($1::uuid[])", [createdWorkspaces]);
    }
    // Any workspace still owned by a test user (created inside a test).
    if (createdUsers.length > 0) {
      await sql.query("delete from public.workspaces where owner_id = any($1::uuid[])", [createdUsers]);
    }
  } finally {
    await sql.end();
  }
  await Promise.all(createdUsers.map((id) => admin().auth.admin.deleteUser(id)));
  createdUsers.length = 0;
  createdWorkspaces.length = 0;
}

/** Direct Postgres connection (superuser) for meta-tests and claim simulation. */
export async function pgClient(): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString:
      process.env.SUPABASE_DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  });
  await client.connect();
  return client;
}

/**
 * Run SQL exactly as PostgREST would for a request carrying these JWT claims
 * (role "authenticated", claims in request.jwt.claims). Lets tests simulate
 * tokens we cannot mint through the auth server: stale logins and OAuth
 * (MCP) clients. Always rolled back.
 */
export async function sqlAsClaims(
  claims: Record<string, unknown>,
  query: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const client = await pgClient();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query("set local role authenticated");
    try {
      const result = await client.query(query, params);
      return { rows: result.rows };
    } catch (error) {
      return { rows: [], error: (error as Error).message };
    }
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const freshAmr = () => [{ method: "password", timestamp: nowSeconds() }];

/** Assert a service call is refused with a permission error. */
export async function expectDenied(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the call to be refused, but it succeeded").toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe("permission_denied");
}

/** Assert a service call fails with a given error code. */
export async function expectCode(promise: Promise<unknown>, code: AppError["code"]): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `expected error "${code}", but the call succeeded`).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}
