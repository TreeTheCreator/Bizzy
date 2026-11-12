import { describe, expect, it } from "vitest";
import { authorize, authorizeAnyAccess, authorizeMember } from "@/server/authz/authorize";
import { type Level, type OwnerAction, type Page, type PageAction, OWNER_ACTIONS, PAGES } from "@/server/authz/pages";
import type { Channel, Ctx } from "@/server/context";
import { AppError } from "@/server/errors";

// authorize() is tested here against a stubbed my_access() result, so every
// branch can be exercised without a database. The real SQL resolution is
// covered by the tests in tests/db.

const WS = "00000000-0000-4000-8000-000000000001";

interface Stub {
  member?: boolean;
  is_owner?: boolean;
  levels?: Partial<Record<Page, Level>>;
  recent_auth?: boolean;
  oauth_client?: boolean;
}

function ctxWith(stub: Stub, channel: Channel = "web"): Ctx & { denials: string[] } {
  const denials: string[] = [];
  const levels = Object.fromEntries(PAGES.map((p) => [p, stub.levels?.[p] ?? "none"]));
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "my_access") {
        return {
          data: {
            member: stub.member ?? true,
            is_owner: stub.is_owner ?? false,
            role_id: null,
            role_name: null,
            role_kind: null,
            levels,
            sensitive: Object.fromEntries(PAGES.map((p) => [p, false])),
            recent_auth: stub.recent_auth ?? true,
            oauth_client: stub.oauth_client ?? false,
          },
          error: null,
        };
      }
      if (fn === "log_event") {
        denials.push(String(args.p_target));
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  return { userId: "u", email: "u@example.com", db: db as never, channel, denials };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "ok",
    (e) => (e instanceof AppError ? e.code : `unexpected: ${e}`),
  );
}

describe("authorize: page levels", () => {
  const actions: PageAction[] = ["view", "edit", "manage"];
  const levels: Level[] = ["none", "view", "edit", "manage"];
  const rank = { none: 0, view: 1, edit: 2, manage: 3 };

  for (const level of levels) {
    for (const action of actions) {
      const allowed = rank[level] >= rank[action];
      it(`level ${level} ${allowed ? "may" : "may not"} ${action}`, async () => {
        const ctx = ctxWith({ levels: { tasks: level } });
        expect(await codeOf(authorize(ctx, WS, "tasks", action))).toBe(allowed ? "ok" : "permission_denied");
      });
    }
  }

  it("a level on one page grants nothing on another", async () => {
    const ctx = ctxWith({ levels: { tasks: "manage" } });
    expect(await codeOf(authorize(ctx, WS, "finance", "view"))).toBe("permission_denied");
  });

  it("logs every denial with page and action", async () => {
    const ctx = ctxWith({ levels: {} });
    await codeOf(authorize(ctx, WS, "docs", "edit"));
    expect(ctx.denials).toEqual(["docs:edit"]);
  });

  it("does not log when access is granted", async () => {
    const ctx = ctxWith({ levels: { docs: "edit" } });
    await authorize(ctx, WS, "docs", "edit");
    expect(ctx.denials).toEqual([]);
  });
});

describe("authorize: owner-only actions", () => {
  const allManage = Object.fromEntries(PAGES.map((p) => [p, "manage"])) as Record<Page, Level>;

  for (const action of OWNER_ACTIONS) {
    it(`${action}: refused for a Full Access holder (manage everywhere, not owner)`, async () => {
      const ctx = ctxWith({ is_owner: false, levels: allManage });
      expect(await codeOf(authorize(ctx, WS, "settings", action))).toBe("permission_denied");
      expect(ctx.denials).toEqual([`settings:${action}`]);
    });

    it(`${action}: allowed for the owner on the web with a fresh login`, async () => {
      const ctx = ctxWith({ is_owner: true, levels: allManage, recent_auth: true });
      expect(await codeOf(authorize(ctx, WS, "settings", action))).toBe("ok");
    });

    for (const channel of ["mcp", "api"] as const) {
      it(`${action}: refused for the owner over ${channel}`, async () => {
        const ctx = ctxWith({ is_owner: true, levels: allManage }, channel);
        expect(await codeOf(authorize(ctx, WS, "settings", action))).toBe("permission_denied");
      });
    }

    it(`${action}: refused for the owner when the token belongs to an OAuth client`, async () => {
      const ctx = ctxWith({ is_owner: true, levels: allManage, oauth_client: true });
      expect(await codeOf(authorize(ctx, WS, "settings", action))).toBe("permission_denied");
    });
  }

  const needReauth = OWNER_ACTIONS.filter((a) => a !== "audit.read") as OwnerAction[];
  for (const action of needReauth) {
    it(`${action}: owner with a stale login must re-enter the password`, async () => {
      const ctx = ctxWith({ is_owner: true, levels: allManage, recent_auth: false });
      expect(await codeOf(authorize(ctx, WS, "settings", action))).toBe("reauth_required");
    });
  }

  it("audit.read does not need a fresh login", async () => {
    const ctx = ctxWith({ is_owner: true, levels: allManage, recent_auth: false });
    expect(await codeOf(authorize(ctx, WS, "settings", "audit.read"))).toBe("ok");
  });
});

describe("authorizeAnyAccess / authorizeMember", () => {
  it("a member with no role has no access but is still a member", async () => {
    const ctx = ctxWith({ member: true, levels: {} });
    expect(await codeOf(authorizeAnyAccess(ctx, WS))).toBe("permission_denied");
    expect(await codeOf(authorizeMember(ctx, WS))).toBe("ok");
  });

  it("a non-member is refused by both", async () => {
    const ctx = ctxWith({ member: false, levels: {} });
    expect(await codeOf(authorizeAnyAccess(ctx, WS))).toBe("permission_denied");
    expect(await codeOf(authorizeMember(ctx, WS))).toBe("permission_denied");
  });

  it("one viewable page is enough for any-access", async () => {
    const ctx = ctxWith({ levels: { docs: "view" } });
    expect(await codeOf(authorizeAnyAccess(ctx, WS))).toBe("ok");
  });
});
