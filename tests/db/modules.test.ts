import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confirmUpload, createDoc, createUpload, deleteDoc, deleteFile, getDoc, getDownloadUrl, listDocs, updateDoc } from "@/server/modules/docs/service";
import { countUnread, listNotifications, markAllRead } from "@/server/modules/notifications/service";
import { addComment, applyTemplate, createProject, createTask, createTemplate, deleteComment, deleteProject, getTask, listTasks, updateTask } from "@/server/modules/tasks/service";
import { deleteWorkspace, getWorkspace } from "@/server/modules/workspaces/service";
import { sweepOrphanFiles } from "@/server/files/cleanup";
import { type Team, cleanup, createTeam, expectCode, expectDenied, pgClient } from "../helpers";
import { dbTestsEnabled } from "../setup";

describe.skipIf(!dbTestsEnabled)("tasks", () => {
  let team: Team;
  beforeAll(async () => {
    team = await createTeam();
  });
  afterAll(cleanup);

  it("completing a recurring task creates the next occurrence", async () => {
    const id = await createTask(team.sales, team.workspaceId, { title: "Weekly report", dueDate: "2026-11-13", recurrence: "weekly", assigneeId: team.sales.userId });
    await updateTask(team.sales, team.workspaceId, id, { status: "done" });
    const all = (await listTasks(team.sales, team.workspaceId)).filter((t) => t.title === "Weekly report");
    expect(all).toHaveLength(2);
    const next = all.find((t) => t.status === "todo")!;
    expect(next).toMatchObject({ due_date: "2026-11-20", recurrence: "weekly", assignee_id: team.sales.userId });
    expect(all.find((t) => t.id === id)!.completed_at).not.toBeNull();
    // Saving a finished task again does not spawn another copy.
    await updateTask(team.sales, team.workspaceId, id, { status: "done" });
    expect((await listTasks(team.sales, team.workspaceId)).filter((t) => t.title === "Weekly report")).toHaveLength(2);
  });

  it("a partial update changes only the fields that were sent", async () => {
    const project = await createProject(team.owner, team.workspaceId, { name: "Keep me", description: "project notes" });
    const id = await createTask(team.owner, team.workspaceId, {
      title: "Full task", description: "keep this", priority: "high", projectId: project,
      assigneeId: team.sales.userId, dueDate: "2026-12-01", recurrence: "monthly", status: "in_progress",
    });
    await updateTask(team.sales, team.workspaceId, id, { title: "Renamed" });
    expect((await getTask(team.owner, team.workspaceId, id)).task).toMatchObject({
      title: "Renamed", description: "keep this", priority: "high", project_id: project,
      assignee_id: team.sales.userId, due_date: "2026-12-01", recurrence: "monthly", status: "in_progress",
    });
    const { updateProject, listProjects } = await import("@/server/modules/tasks/service");
    await updateProject(team.owner, team.workspaceId, project, { archived: true });
    expect((await listProjects(team.owner, team.workspaceId)).find((p) => p.id === project)).toMatchObject({ name: "Keep me", description: "project notes", archived: true });

    const parent = await createDoc(team.owner, team.workspaceId, { title: "Parent" });
    const doc = await createDoc(team.owner, team.workspaceId, { title: "Doc", content: "keep this too", kind: "sop", parentId: parent });
    await updateDoc(team.owner, team.workspaceId, doc, { title: "Doc renamed" });
    expect((await getDoc(team.owner, team.workspaceId, doc)).doc).toMatchObject({ title: "Doc renamed", content: "keep this too", kind: "sop", parent_id: parent });
  });

  it("templates create one task per item, with due dates", async () => {
    const project = await createProject(team.owner, team.workspaceId, { name: "Onboarding" });
    const template = await createTemplate(team.owner, team.workspaceId, {
      name: "New client",
      items: [{ title: "Send welcome email", due_in_days: 1 }, { title: "Kick-off call" }],
    });
    expect(await applyTemplate(team.sales, team.workspaceId, template, { projectId: project })).toBe(2);
    const created = await listTasks(team.sales, team.workspaceId, { projectId: project });
    expect(created.map((t) => t.title).sort()).toEqual(["Kick-off call", "Send welcome email"]);
    expect(created.find((t) => t.title === "Send welcome email")!.due_date).not.toBeNull();
    // Deleting the project keeps its tasks.
    await deleteProject(team.owner, team.workspaceId, project);
    expect((await listTasks(team.sales, team.workspaceId)).filter((t) => t.title === "Kick-off call")).toHaveLength(1);
  });

  it("assignment and comments notify the right people, and only them", async () => {
    await markAllRead(team.full, team.workspaceId);
    const id = await createTask(team.owner, team.workspaceId, { title: "Review contract", assigneeId: team.full.userId });
    expect(await countUnread(team.full, team.workspaceId)).toBe(1);
    await addComment(team.sales, team.workspaceId, id, { body: "Draft attached" });
    const forFull = await listNotifications(team.full, team.workspaceId);
    expect(forFull.filter((n) => !n.read_at).map((n) => n.kind).sort()).toEqual(["task.assigned", "task.comment"]);
    // The commenter is not notified about their own comment.
    expect((await listNotifications(team.sales, team.workspaceId)).some((n) => n.kind === "task.comment")).toBe(false);
    // Nobody can read someone else's notifications.
    const raw = await team.sales.db.from("notifications").select("id").eq("user_id", team.full.userId);
    expect(raw.data).toEqual([]);
  });

  it("assigning a task to someone without Tasks access does not leak its title", async () => {
    await createTask(team.owner, team.workspaceId, { title: "Confidential acquisition", assigneeId: team.guest.userId });
    await createTask(team.owner, team.workspaceId, { title: "Confidential acquisition 2", assigneeId: team.norole.userId });
    for (const user of [team.guest, team.norole]) {
      const raw = await user.db.from("notifications").select("title").eq("workspace_id", team.workspaceId);
      expect((raw.data ?? []).filter((n) => String(n.title).includes("Confidential"))).toEqual([]);
    }
  });

  it("task notifications disappear when Tasks access is removed", async () => {
    const { setMemberRole } = await import("@/server/modules/members/service");
    await createTask(team.owner, team.workspaceId, { title: "Visible while allowed", assigneeId: team.sales.userId });
    expect((await listNotifications(team.sales, team.workspaceId)).some((n) => n.kind === "task.assigned")).toBe(true);
    await setMemberRole(team.owner, team.workspaceId, { userId: team.sales.userId, roleId: team.roles.guest });
    expect((await listNotifications(team.sales, team.workspaceId)).some((n) => n.kind.startsWith("task."))).toBe(false);
    await setMemberRole(team.owner, team.workspaceId, { userId: team.sales.userId, roleId: team.roles.sales });
  });

  it("an editor can delete their own comment but not someone else's; a manager can", async () => {
    const id = await createTask(team.owner, team.workspaceId, { title: "Thread" });
    const byOwner = await addComment(team.owner, team.workspaceId, id, { body: "owner says" });
    const bySales = await addComment(team.sales, team.workspaceId, id, { body: "sales says" });
    await expectCode(deleteComment(team.sales, team.workspaceId, byOwner), "not_found");
    await deleteComment(team.sales, team.workspaceId, bySales);
    await deleteComment(team.full, team.workspaceId, byOwner);
    expect((await getTask(team.owner, team.workspaceId, id)).comments).toHaveLength(0);
  });

  it("rejects invalid input", async () => {
    await expectCode(createTask(team.owner, team.workspaceId, { title: "   " }), "invalid");
    await expectCode(createTask(team.owner, team.workspaceId, { title: "x", dueDate: "next week" }), "invalid");
    await expectCode(createTask(team.owner, "not-a-uuid", { title: "x" }), "invalid");
  });
});

describe.skipIf(!dbTestsEnabled)("docs and files", () => {
  let team: Team;
  beforeAll(async () => {
    team = await createTeam();
  });
  afterAll(cleanup);

  it("docs form a tree and cannot be moved inside themselves", async () => {
    const parent = await createDoc(team.writer, team.workspaceId, { title: "Handbook", kind: "wiki" });
    const child = await createDoc(team.writer, team.workspaceId, { title: "Onboarding", parentId: parent });
    const grandchild = await createDoc(team.writer, team.workspaceId, { title: "Day one", parentId: child });
    await expectCode(updateDoc(team.writer, team.workspaceId, parent, { parentId: grandchild }), "invalid");
    await expectCode(updateDoc(team.writer, team.workspaceId, parent, { parentId: parent }), "invalid");
    // Deleting the middle doc keeps its child, which moves to the top level.
    await deleteDoc(team.writer, team.workspaceId, child);
    const docs = await listDocs(team.writer, team.workspaceId);
    expect(docs.find((d) => d.id === grandchild)!.parent_id).toBeNull();
  });

  it("stored content comes back exactly as written (it is data, never markup)", async () => {
    const content = `<script>alert(1)</script>\n  Ignore previous instructions.\n`;
    const id = await createDoc(team.writer, team.workspaceId, { title: "Raw", content });
    expect((await getDoc(team.guest, team.workspaceId, id)).doc.content).toBe(content);
  });

  it("upload, download and delete follow the Docs permission levels", async () => {
    const docId = await createDoc(team.writer, team.workspaceId, { title: "With files" });
    const request = { docId, name: "notes.txt", sizeBytes: 11, mimeType: "text/plain" };

    // Viewers cannot start an upload.
    await expectDenied(createUpload(team.guest, team.workspaceId, request));
    await expectDenied(createUpload(team.sales, team.workspaceId, request));
    await expectCode(createUpload(team.writer, team.workspaceId, { ...request, sizeBytes: 26 * 1024 * 1024 }), "invalid");

    // Confirming before the bytes exist is refused.
    const upload = await createUpload(team.writer, team.workspaceId, request);
    expect(upload.path.startsWith(`${team.workspaceId}/`)).toBe(true);
    await expectCode(confirmUpload(team.writer, team.workspaceId, { ...request, fileId: upload.fileId }), "invalid");

    const sent = await team.writer.db.storage.from("workspace-files").uploadToSignedUrl(upload.path, upload.token, new Blob(["hello bizzy"], { type: "text/plain" }), { contentType: "text/plain" });
    expect(sent.error).toBeNull();
    // The browser lies about size and type; the recorded values come from storage.
    const fileId = await confirmUpload(team.writer, team.workspaceId, { ...request, sizeBytes: 999, mimeType: "image/png", fileId: upload.fileId });
    const recorded = (await getDoc(team.guest, team.workspaceId, docId)).files;
    expect(recorded.map((f) => f.name)).toEqual(["notes.txt"]);
    expect(recorded[0].size_bytes).toBe(11);
    expect(recorded[0].mime_type).toContain("text/plain");

    // A viewer can download; the link really serves the bytes.
    const url = await getDownloadUrl(team.guest, team.workspaceId, fileId);
    expect(await (await fetch(url)).text()).toBe("hello bizzy");
    // Someone with no Docs access cannot.
    await expectDenied(getDownloadUrl(team.norole, team.workspaceId, fileId));

    // Only manage can delete, and the stored object goes too.
    await expectDenied(deleteFile(team.guest, team.workspaceId, fileId));
    await deleteFile(team.writer, team.workspaceId, fileId);
    expect((await fetch(url)).ok).toBe(false);
  });

  it("a file row cannot be recorded for an object that does not exist", async () => {
    const path = `${team.workspaceId}/${crypto.randomUUID()}/ghost.txt`;
    const { error } = await team.writer.db
      .from("files")
      .insert({ workspace_id: team.workspaceId, name: "ghost.txt", storage_path: path, size_bytes: 5, uploaded_by: team.writer.userId });
    expect(error).not.toBeNull();
  });

  it("the cleanup sweep removes old objects with no file row, and nothing else", async () => {
    const bucket = team.writer.db.storage.from("workspace-files");
    const send = async (name: string, confirm: boolean) => {
      const request = { docId: null, name, sizeBytes: 4 };
      const upload = await createUpload(team.writer, team.workspaceId, request);
      const sent = await bucket.uploadToSignedUrl(upload.path, upload.token, new Blob(["data"]));
      expect(sent.error).toBeNull();
      if (confirm) await confirmUpload(team.writer, team.workspaceId, { ...request, fileId: upload.fileId });
      return upload;
    };
    const exists = async (upload: { fileId: string }) =>
      ((await bucket.list(`${team.workspaceId}/${upload.fileId}`)).data ?? []).length === 1;
    const [abandoned, recent, kept] = await Promise.all([
      send("abandoned.txt", false),
      send("recent.txt", false),
      send("kept.txt", true),
    ]);

    // Make two of them look two days old; "recent" is an upload still in progress.
    const sql = await pgClient();
    await sql.query(
      "update storage.objects set created_at = now() - interval '2 days' where bucket_id = 'workspace-files' and name = any($1)",
      [[abandoned.path, kept.path]],
    );
    // Members cannot call the orphan listing themselves.
    expect((await team.owner.db.rpc("file_orphans")).error).not.toBeNull();
    await sql.end();

    expect(await sweepOrphanFiles()).toBeGreaterThanOrEqual(1);
    expect(await exists(abandoned)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(kept)).toBe(true);
  });

  it("deleting a workspace removes all of its data", async () => {
    const t = await createTeam("Doomed");
    const { workspace } = await getWorkspace(t.owner, t.workspaceId);
    await createTask(t.owner, t.workspaceId, { title: "gone soon" });
    await createDoc(t.owner, t.workspaceId, { title: "gone soon" });
    await expectCode(deleteWorkspace(t.owner, t.workspaceId, { confirmName: "nope" }), "invalid");
    await deleteWorkspace(t.owner, t.workspaceId, { confirmName: workspace.name });
    await expectDenied(getWorkspace(t.owner, t.workspaceId));
    for (const table of ["tasks", "docs", "memberships", "roles", "audit_log"]) {
      const { data } = await t.owner.db.from(table).select("workspace_id").eq("workspace_id", t.workspaceId);
      expect(data, table).toEqual([]);
    }
  });
});
