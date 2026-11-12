import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAudit } from "@/server/modules/audit/service";
import { createDoc, deleteDoc, getDoc, listDocs, updateDoc } from "@/server/modules/docs/service";
import { createInvite, listMembers, listPeople } from "@/server/modules/members/service";
import { listRoles } from "@/server/modules/roles/service";
import { search } from "@/server/modules/search/service";
import {
  addComment,
  createProject,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  updateTask,
} from "@/server/modules/tasks/service";
import { getWorkspace, renameWorkspace } from "@/server/modules/workspaces/service";
import { type Team, type TestUser, cleanup, createTeam, createUser, expectDenied } from "../helpers";
import { dbTestsEnabled } from "../setup";

// Role x page x action, exercised through the real service functions against
// the real database. "outsider" is a signed-in user who is not a member.

type Actor = "owner" | "full" | "sales" | "writer" | "guest" | "norole" | "outsider";
const ACTORS: Actor[] = ["owner", "full", "sales", "writer", "guest", "norole", "outsider"];

describe.skipIf(!dbTestsEnabled)("access matrix (services + database)", () => {
  let team: Team;
  let outsider: TestUser;
  let taskId: string;
  let docId: string;
  const user = (actor: Actor): TestUser => (actor === "outsider" ? outsider : team[actor]);

  beforeAll(async () => {
    team = await createTeam();
    outsider = await createUser("outsider");
    taskId = await createTask(team.owner, team.workspaceId, { title: "Seed task" });
    docId = await createDoc(team.owner, team.workspaceId, { title: "Seed doc", content: "pineapple handbook" });
  });
  afterAll(cleanup);

  /** One row per protected operation: who is allowed, and how to attempt it. */
  const cases: { name: string; allowed: Actor[]; attempt: (u: TestUser) => Promise<unknown> }[] = [
    // Tasks
    { name: "tasks.view: list tasks", allowed: ["owner", "full", "sales"], attempt: (u) => listTasks(u, team.workspaceId) },
    { name: "tasks.view: read one task", allowed: ["owner", "full", "sales"], attempt: (u) => getTask(u, team.workspaceId, taskId) },
    { name: "tasks.edit: create task", allowed: ["owner", "full", "sales"], attempt: (u) => createTask(u, team.workspaceId, { title: "t" }) },
    { name: "tasks.edit: update task", allowed: ["owner", "full", "sales"], attempt: (u) => updateTask(u, team.workspaceId, taskId, { priority: "high" }) },
    { name: "tasks.edit: comment", allowed: ["owner", "full", "sales"], attempt: (u) => addComment(u, team.workspaceId, taskId, { body: "hi" }) },
    { name: "tasks.edit: create project", allowed: ["owner", "full", "sales"], attempt: (u) => createProject(u, team.workspaceId, { name: `p-${u.userId.slice(0, 8)}` }) },
    {
      name: "tasks.manage: delete task",
      allowed: ["owner", "full"],
      attempt: async (u) => deleteTask(u, team.workspaceId, await createTask(team.owner, team.workspaceId, { title: "to delete" })),
    },
    // Docs
    { name: "docs.view: list docs", allowed: ["owner", "full", "sales", "writer", "guest"], attempt: (u) => listDocs(u, team.workspaceId) },
    { name: "docs.view: read one doc", allowed: ["owner", "full", "sales", "writer", "guest"], attempt: (u) => getDoc(u, team.workspaceId, docId) },
    { name: "docs.edit: create doc", allowed: ["owner", "full", "writer"], attempt: (u) => createDoc(u, team.workspaceId, { title: "d" }) },
    { name: "docs.edit: update doc", allowed: ["owner", "full", "writer"], attempt: (u) => updateDoc(u, team.workspaceId, docId, { title: "Seed doc" }) },
    {
      name: "docs.manage: delete doc",
      allowed: ["owner", "full", "writer"],
      attempt: async (u) => deleteDoc(u, team.workspaceId, await createDoc(team.owner, team.workspaceId, { title: "to delete" })),
    },
    // Settings
    { name: "settings.view: list members", allowed: ["owner", "full"], attempt: (u) => listMembers(u, team.workspaceId) },
    { name: "settings.view: list roles", allowed: ["owner", "full"], attempt: (u) => listRoles(u, team.workspaceId) },
    { name: "settings.manage: create invite", allowed: ["owner", "full"], attempt: (u) => createInvite(u, team.workspaceId, { email: `x-${u.userId.slice(0, 8)}@test.bizzy.local` }) },
    { name: "settings.manage: rename workspace", allowed: ["owner", "full"], attempt: (u) => renameWorkspace(u, team.workspaceId, { name: "Acme renamed" }) },
    // Owner only
    { name: "audit.read: owner only", allowed: ["owner"], attempt: (u) => listAudit(u, team.workspaceId) },
    // Any access / membership
    { name: "any access: people list", allowed: ["owner", "full", "sales", "writer", "guest"], attempt: (u) => listPeople(u, team.workspaceId) },
    { name: "any access: search", allowed: ["owner", "full", "sales", "writer", "guest"], attempt: (u) => search(u, team.workspaceId, "seed") },
    { name: "membership: open workspace shell", allowed: ["owner", "full", "sales", "writer", "guest", "norole"], attempt: (u) => getWorkspace(u, team.workspaceId) },
  ];

  for (const testCase of cases) {
    for (const actor of ACTORS) {
      const allowed = testCase.allowed.includes(actor);
      it(`${testCase.name} · ${actor} ${allowed ? "allowed" : "DENIED"}`, async () => {
        if (allowed) await expect(testCase.attempt(user(actor))).resolves.not.toThrow();
        else await expectDenied(testCase.attempt(user(actor)));
      });
    }
  }

  it("a member with no role sees nothing through the raw database either", async () => {
    for (const table of ["tasks", "docs", "projects", "task_comments", "files", "roles", "role_permissions", "invites", "audit_log"]) {
      const { data, error } = await team.norole.db.from(table).select("*").eq("workspace_id", team.workspaceId);
      expect(error, table).toBeNull();
      expect(data, table).toEqual([]);
    }
    // They can see their own membership row and nobody else's.
    const { data: memberships } = await team.norole.db.from("memberships").select("user_id").eq("workspace_id", team.workspaceId);
    expect(memberships).toEqual([{ user_id: team.norole.userId }]);
  });

  it("search only returns results from pages the caller can view", async () => {
    await createTask(team.owner, team.workspaceId, { title: "pineapple invoice follow-up" });
    const forSales = await search(team.sales, team.workspaceId, "pineapple"); // tasks edit + docs view
    expect(new Set(forSales.map((h) => h.page))).toEqual(new Set(["tasks", "docs"]));
    const forWriter = await search(team.writer, team.workspaceId, "pineapple"); // docs only
    expect(forWriter.length).toBeGreaterThan(0);
    expect(forWriter.every((h) => h.page === "docs")).toBe(true);
  });

  it("Full Access gets manage on every page, including ones with no UI yet", async () => {
    const { access } = await getWorkspace(team.full, team.workspaceId);
    expect(Object.values(access.levels).every((level) => level === "manage")).toBe(true);
    expect(access.isOwner).toBe(false);
  });

  it("a custom role gets 'none' for every page it does not list", async () => {
    const { access } = await getWorkspace(team.sales, team.workspaceId);
    expect(access.levels).toMatchObject({ tasks: "edit", docs: "view", finance: "none", crm: "none", hr: "none", settings: "none" });
  });
});
