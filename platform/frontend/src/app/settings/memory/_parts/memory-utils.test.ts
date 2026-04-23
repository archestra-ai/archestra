import { describe, expect, it } from "vitest";
import {
  canApproveMemoryByScope,
  getDefaultMemoryStatusTab,
  normalizeMemoryRole,
} from "./memory-utils";

describe("memory-utils", () => {
  it("defaults status tab to pending review for reviewers", () => {
    expect(getDefaultMemoryStatusTab(true)).toBe("candidate");
    expect(getDefaultMemoryStatusTab(false)).toBe("approved");
  });

  it("normalizes role aliases for team admins", () => {
    expect(normalizeMemoryRole("editor")).toBe("team-admin");
    expect(normalizeMemoryRole("team_admin")).toBe("team-admin");
    expect(normalizeMemoryRole("admin")).toBe("admin");
    expect(normalizeMemoryRole("member")).toBe("member");
  });

  it("allows users to approve only their own user-scoped memory", () => {
    expect(
      canApproveMemoryByScope({
        item: { scopeType: "user", scopeId: "u-1" },
        currentUserId: "u-1",
        currentRole: "member",
        organizationId: "org-1",
        teamIds: [],
      }),
    ).toBe(true);

    expect(
      canApproveMemoryByScope({
        item: { scopeType: "user", scopeId: "u-2" },
        currentUserId: "u-1",
        currentRole: "member",
        organizationId: "org-1",
        teamIds: [],
      }),
    ).toBe(false);
  });

  it("requires role and membership checks for team and organization scopes", () => {
    expect(
      canApproveMemoryByScope({
        item: { scopeType: "team", scopeId: "t-1" },
        currentUserId: "u-1",
        currentRole: "team-admin",
        organizationId: "org-1",
        teamIds: ["t-1"],
      }),
    ).toBe(true);

    expect(
      canApproveMemoryByScope({
        item: { scopeType: "team", scopeId: "t-2" },
        currentUserId: "u-1",
        currentRole: "team-admin",
        organizationId: "org-1",
        teamIds: ["t-1"],
      }),
    ).toBe(false);

    expect(
      canApproveMemoryByScope({
        item: { scopeType: "organization", scopeId: "org-1" },
        currentUserId: "u-1",
        currentRole: "admin",
        organizationId: "org-1",
        teamIds: [],
      }),
    ).toBe(true);

    expect(
      canApproveMemoryByScope({
        item: { scopeType: "organization", scopeId: "org-2" },
        currentUserId: "u-1",
        currentRole: "admin",
        organizationId: "org-1",
        teamIds: [],
      }),
    ).toBe(false);
  });
});
