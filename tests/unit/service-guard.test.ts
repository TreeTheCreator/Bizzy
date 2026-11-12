import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Structural guard for the "single authorization layer" rule: every exported
// function in every service module must call authorize() (or one of its
// variants) as its FIRST statement, unless it carries an explicit
// "// authz: user-scoped (reason)" comment directly above it.

const MODULES = join(process.cwd(), "src", "server", "modules");
const PURE_HELPERS = new Set(["nextDueDate"]); // no data access, no ctx

interface Fn {
  file: string;
  name: string;
  optedOut: boolean;
  body: string;
}

function exportedFunctions(file: string): Fn[] {
  const source = readFileSync(file, "utf8");
  const found: Fn[] = [];
  const pattern = /^export (?:async )?function (\w+)\s*\(/gm;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const before = source.slice(0, match.index).trimEnd().split("\n");
    const optedOut = /^\/\/ authz: user-scoped \(.+\)$/.test(before.at(-1)?.trim() ?? "");
    // Find the opening brace of the function body: the first "{" after the
    // parameter list and return type close at depth 0.
    let depth = 0;
    let i = match.index + match[0].length - 1;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) break;
    }
    // Skip the return type (which may contain braces) up to the "{" that starts a line's block.
    const bodyStart = source.indexOf("{\n", i);
    const bodyEnd = source.indexOf("\n}\n", bodyStart);
    found.push({ file, name: match[1], optedOut, body: source.slice(bodyStart + 1, bodyEnd) });
  }
  return found;
}

const services = readdirSync(MODULES).map((dir) => join(MODULES, dir, "service.ts"));
const functions = services.flatMap(exportedFunctions).filter((fn) => !PURE_HELPERS.has(fn.name));

describe("every service function is authorized", () => {
  it("finds the service modules", () => {
    expect(services.length).toBeGreaterThanOrEqual(8);
    expect(functions.length).toBeGreaterThan(40);
  });

  for (const fn of functions) {
    it(`${fn.file.split(/[\\/]/).slice(-2).join("/")} · ${fn.name}`, () => {
      if (fn.optedOut) {
        // Opt-outs must not take a workspace and then skip the check silently:
        // they rely on RLS / definer functions scoped to the caller.
        expect(fn.body).not.toMatch(/\bauthorize\w*\(/);
        return;
      }
      const firstStatement = fn.body.trim().split("\n")[0];
      expect(firstStatement, "first statement must be an authorize call").toMatch(
        /\b(?:await|=\s*await)\s+authorize(?:AnyAccess|Member)?\(ctx, /,
      );
    });
  }

  it("the opt-out list is exactly the reviewed set", () => {
    expect(functions.filter((f) => f.optedOut).map((f) => f.name).sort()).toEqual(
      [
        "acceptInvite",
        "countUnread",
        "createWorkspace",
        "leaveWorkspace",
        "listMyWorkspaces",
        "listNotifications",
        "markAllRead",
        "previewInvite",
        "recordLogin",
      ].sort(),
    );
  });
});
