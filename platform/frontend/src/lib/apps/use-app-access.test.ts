import { describe, expect, it } from "vitest";
import {
  type AppAccessContext,
  appActionDisabledReason,
  computeAppAccess,
} from "./use-app-access";

const baseContext: AppAccessContext = {
  isAdmin: false,
  isTeamAdmin: false,
  canUpdate: true,
  canDelete: true,
  currentUserId: "me",
  userTeamIds: new Set(["my-team"]),
  isPending: false,
};

describe("computeAppAccess", () => {
  it("does not treat an app:update permission or authorship as authority over a team app", () => {
    const access = computeAppAccess(
      {
        scope: "team",
        authorId: "me",
        teams: [{ id: "my-team", name: "My team" }],
      },
      baseContext,
    );

    expect(access.canEdit).toBe(false);
    expect(access.canDeleteApp).toBe(false);
  });

  it("allows a team admin to modify apps assigned to one of their teams", () => {
    const access = computeAppAccess(
      {
        scope: "team",
        authorId: "someone-else",
        teams: [{ id: "my-team", name: "My team" }],
      },
      { ...baseContext, isTeamAdmin: true },
    );

    expect(access.canEdit).toBe(true);
    expect(access.canDeleteApp).toBe(true);
  });

  it("allows an app admin to manage a team app without team membership", () => {
    const access = computeAppAccess(
      {
        scope: "team",
        authorId: "someone-else",
        teams: [{ id: "other-team", name: "Other team" }],
      },
      { ...baseContext, isAdmin: true },
    );

    expect(access.canEdit).toBe(true);
    expect(access.canDeleteApp).toBe(true);
  });
});

describe("appActionDisabledReason", () => {
  const orgApp = {
    scope: "org" as const,
    authorId: "someone-else",
    teams: [],
  };

  it("names the base permission before evaluating the app scope", () => {
    const access = computeAppAccess(orgApp, {
      ...baseContext,
      canUpdate: false,
    });

    expect(
      appActionDisabledReason({ app: orgApp, access, action: "update" }),
    ).toBe("Available to roles with the Apps (update) permission");
  });

  it("names the scope rule when the role permits updates", () => {
    const access = computeAppAccess(orgApp, baseContext);

    expect(
      appActionDisabledReason({ app: orgApp, access, action: "update" }),
    ).toBe("Only an admin can change this org-wide app");
  });

  it("returns no reason when the action is available", () => {
    const access = computeAppAccess(orgApp, { ...baseContext, isAdmin: true });

    expect(
      appActionDisabledReason({ app: orgApp, access, action: "update" }),
    ).toBeUndefined();
  });
});
