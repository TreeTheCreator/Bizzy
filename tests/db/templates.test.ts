import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listDocs } from "@/server/modules/docs/service";
import { listProjects, listTasks, listTemplates } from "@/server/modules/tasks/service";
import { BUSINESS_TEMPLATES, BUSINESS_TEMPLATE_KEYS, applyBusinessTemplate } from "@/server/modules/templates/service";
import { createWorkspace } from "@/server/modules/workspaces/service";
import { type Team, cleanup, createTeam, expectCode, expectDenied } from "../helpers";
import { dbTestsEnabled } from "../setup";

// Phase 3: business templates. A starter kit is created through the ordinary
// services, by someone who may manage the workspace's settings.

describe.skipIf(!dbTestsEnabled)("business templates", () => {
  let team: Team;
  beforeAll(async () => {
    team = await createTeam("Templates");
  });
  afterAll(cleanup);

  it("every template fills a new workspace with its starter kit", async () => {
    for (const key of BUSINESS_TEMPLATE_KEYS) {
      const starter = BUSINESS_TEMPLATES[key];
      const ws = await createWorkspace(team.owner, { name: `Starter ${key}` });
      const made = await applyBusinessTemplate(team.owner, ws, { template: key });
      expect(made).toEqual({ tasks: starter.project.tasks.length, taskLists: starter.taskLists.length, docs: starter.docs.length });

      const projects = await listProjects(team.owner, ws);
      expect(projects.map((p) => p.name)).toEqual([starter.project.name]);
      const tasks = await listTasks(team.owner, ws);
      expect(tasks.map((t) => t.title).sort()).toEqual(starter.project.tasks.map((t) => t.title).sort());
      expect(tasks.every((t) => t.project_id === projects[0].id && t.status === "todo" && t.due_date !== null)).toBe(true);
      expect((await listTemplates(team.owner, ws)).map((t) => t.name).sort()).toEqual(starter.taskLists.map((l) => l.name).sort());
      expect((await listDocs(team.owner, ws)).map((d) => d.title).sort()).toEqual(starter.docs.map((d) => d.title).sort());
    }
  });

  it("only someone who manages the workspace's settings can apply one", async () => {
    const ws = team.workspaceId;
    for (const member of [team.sales, team.writer, team.guest, team.norole]) {
      await expectDenied(applyBusinessTemplate(member, ws, { template: "cafe" }));
    }
    await expectCode(applyBusinessTemplate(team.owner, ws, { template: "bank" }), "invalid");
    expect(await listTemplates(team.owner, ws)).toEqual([]);
    // Full Access manages settings, so may apply one.
    await applyBusinessTemplate(team.full, ws, { template: "shop" });
    expect((await listTemplates(team.owner, ws)).length).toBe(BUSINESS_TEMPLATES.shop.taskLists.length);
  });
});
