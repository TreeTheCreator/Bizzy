import { z } from "zod";
import { authorize } from "@/server/authz/authorize";
import type { Ctx } from "@/server/context";
import { createDoc } from "@/server/modules/docs/service";
import { createProject, createTask, createTemplate } from "@/server/modules/tasks/service";
import { id, parse } from "@/server/validate";

/**
 * Business templates: a starter kit for a new workspace. Each one adds a first
 * project with a few tasks, ready-made task lists and a couple of guide docs,
 * all through the ordinary service functions, so nothing here can do more than
 * the person applying it could do by hand.
 */

interface Starter {
  label: string;
  about: string;
  project: { name: string; tasks: { title: string; dueInDays?: number }[] };
  taskLists: { name: string; items: { title: string; due_in_days?: number }[] }[];
  docs: { title: string; kind: "doc" | "wiki" | "sop"; content: string }[];
}

export const BUSINESS_TEMPLATES = {
  cafe: {
    label: "Cafe or restaurant",
    about: "Opening and closing checklists, a supplier list and a first week of setup tasks.",
    project: {
      name: "Getting set up",
      tasks: [
        { title: "Add your team under Settings, People", dueInDays: 2 },
        { title: "Write down your suppliers in the Suppliers doc", dueInDays: 5 },
        { title: "Enter this month's rent and bills under Money, Expenses", dueInDays: 7 },
      ],
    },
    taskLists: [
      {
        name: "Opening the shop",
        items: [
          { title: "Unlock, lights and music on" },
          { title: "Check fridge and freezer temperatures" },
          { title: "Count the cash float" },
          { title: "Set out the counter and menus" },
        ],
      },
      {
        name: "Closing the shop",
        items: [
          { title: "Clean machines and surfaces" },
          { title: "Put away and label food" },
          { title: "Count the till and note the takings" },
          { title: "Bins out, lights off, lock up" },
        ],
      },
      {
        name: "New team member",
        items: [
          { title: "Show them around and explain the menu", due_in_days: 0 },
          { title: "Food safety basics", due_in_days: 1 },
          { title: "First shift alongside someone experienced", due_in_days: 2 },
          { title: "Add them under HR", due_in_days: 2 },
        ],
      },
    ],
    docs: [
      { title: "Suppliers", kind: "wiki", content: "List each supplier here: what they deliver, on which days, who to call, and how you order.\n" },
      { title: "How we open and close", kind: "sop", content: "Use the ready-made task lists \"Opening the shop\" and \"Closing the shop\" under Tasks.\nWrite anything special about your place here.\n" },
    ],
  },
  shop: {
    label: "Shop",
    about: "Stock and supplier notes, a weekly routine and a first week of setup tasks.",
    project: {
      name: "Getting set up",
      tasks: [
        { title: "Add your team under Settings, People", dueInDays: 2 },
        { title: "List your suppliers in the Suppliers doc", dueInDays: 5 },
        { title: "Enter this month's rent and bills under Money, Expenses", dueInDays: 7 },
      ],
    },
    taskLists: [
      {
        name: "Weekly routine",
        items: [
          { title: "Check stock and write the order list" },
          { title: "Place supplier orders" },
          { title: "Tidy displays and price labels" },
          { title: "Bank the takings" },
        ],
      },
      {
        name: "New delivery",
        items: [
          { title: "Check the delivery against the order", due_in_days: 0 },
          { title: "Put stock away and update prices", due_in_days: 1 },
          { title: "Record the bill under Money, Expenses", due_in_days: 2 },
        ],
      },
    ],
    docs: [
      { title: "Suppliers", kind: "wiki", content: "List each supplier here: what you buy, lead times, who to call, and payment terms.\n" },
      { title: "Returns and refunds", kind: "sop", content: "Write down how you handle returns, so everyone answers customers the same way.\n" },
    ],
  },
  services: {
    label: "Agency or freelancer",
    about: "A new-client checklist, a project kick-off list and a place for your offers and prices.",
    project: {
      name: "Getting set up",
      tasks: [
        { title: "Add your current clients under Customers", dueInDays: 3 },
        { title: "Add deals you are working on to the board", dueInDays: 5 },
        { title: "Send any invoices that are waiting under Money", dueInDays: 7 },
      ],
    },
    taskLists: [
      {
        name: "New client",
        items: [
          { title: "Intro call and notes", due_in_days: 0 },
          { title: "Send the quote", due_in_days: 2 },
          { title: "Agree scope and dates in writing", due_in_days: 5 },
          { title: "Add the client and deal under Customers", due_in_days: 5 },
        ],
      },
      {
        name: "Project kick-off",
        items: [
          { title: "Kick-off meeting", due_in_days: 0 },
          { title: "Collect logins, files and contacts", due_in_days: 2 },
          { title: "Share the plan and first milestone", due_in_days: 4 },
        ],
      },
      {
        name: "Project wrap-up",
        items: [
          { title: "Hand over files and logins", due_in_days: 0 },
          { title: "Send the final invoice", due_in_days: 1 },
          { title: "Ask for feedback or a review", due_in_days: 7 },
        ],
      },
    ],
    docs: [
      { title: "What we offer and what it costs", kind: "wiki", content: "List your services, what is included, and your usual prices.\n" },
      { title: "How we run a project", kind: "sop", content: "Describe the steps from first call to final invoice. The ready-made task lists under Tasks follow the same order.\n" },
    ],
  },
  trades: {
    label: "Trades and repairs",
    about: "Job checklists from first visit to final bill, plus a first week of setup tasks.",
    project: {
      name: "Getting set up",
      tasks: [
        { title: "Add the jobs you are quoting for under Customers", dueInDays: 3 },
        { title: "Add your team under Settings, People", dueInDays: 5 },
        { title: "Enter van, tools and insurance costs under Money, Expenses", dueInDays: 7 },
      ],
    },
    taskLists: [
      {
        name: "New job",
        items: [
          { title: "Site visit and measurements", due_in_days: 0 },
          { title: "Send the quote", due_in_days: 2 },
          { title: "Order materials", due_in_days: 5 },
          { title: "Agree the start date with the customer", due_in_days: 5 },
        ],
      },
      {
        name: "Finishing a job",
        items: [
          { title: "Walk through the work with the customer", due_in_days: 0 },
          { title: "Clear the site", due_in_days: 0 },
          { title: "Send the invoice", due_in_days: 1 },
          { title: "Check the invoice was paid", due_in_days: 14 },
        ],
      },
    ],
    docs: [
      { title: "Suppliers and merchants", kind: "wiki", content: "Where you buy materials, account numbers, opening hours and who to call.\n" },
      { title: "Safety on site", kind: "sop", content: "Write down the checks you do before starting work on a site.\n" },
    ],
  },
} as const satisfies Record<string, Starter>;

export type BusinessTemplate = keyof typeof BUSINESS_TEMPLATES;
export const BUSINESS_TEMPLATE_KEYS = Object.keys(BUSINESS_TEMPLATES) as BusinessTemplate[];

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Fill a workspace with a business template's starter kit. Needs Settings
 * manage, so in practice the owner or a Full Access member; each item is then
 * created through the normal Tasks and Docs services under the caller's role.
 */
export async function applyBusinessTemplate(
  ctx: Ctx,
  workspaceId: string,
  input: { template: string },
): Promise<{ tasks: number; taskLists: number; docs: number }> {
  await authorize(ctx, parse(id, workspaceId), "settings", "manage");
  const key = parse(z.enum(BUSINESS_TEMPLATE_KEYS as [BusinessTemplate, ...BusinessTemplate[]]), input.template);
  const starter: Starter = BUSINESS_TEMPLATES[key];

  const projectId = await createProject(ctx, workspaceId, { name: starter.project.name });
  for (const task of starter.project.tasks) {
    await createTask(ctx, workspaceId, {
      title: task.title,
      projectId,
      dueDate: task.dueInDays === undefined ? null : day(task.dueInDays),
    });
  }
  for (const list of starter.taskLists) await createTemplate(ctx, workspaceId, list);
  for (const doc of starter.docs) await createDoc(ctx, workspaceId, doc);
  return { tasks: starter.project.tasks.length, taskLists: starter.taskLists.length, docs: starter.docs.length };
}
