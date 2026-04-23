import { describe, expect, test } from "vitest";
import { canDeleteMemory } from "./can-delete";

describe("canDeleteMemory", () => {
  test("allows deleting user scope only for owner", () => {
    expect(
      canDeleteMemory({
        requesterUserId: "user-1",
        requesterRole: "member",
        organizationId: "org-1",
        item: {
          scopeType: "user",
          scopeId: "user-1",
        },
      }),
    ).toBe(true);

    expect(
      canDeleteMemory({
        requesterUserId: "user-1",
        requesterRole: "member",
        organizationId: "org-1",
        item: {
          scopeType: "user",
          scopeId: "user-2",
        },
      }),
    ).toBe(false);
  });

  test("applies team scope membership checks", () => {
    expect(
      canDeleteMemory({
        requesterUserId: "user-1",
        requesterRole: "team-admin",
        organizationId: "org-1",
        requesterTeamIds: ["team-1"],
        item: {
          scopeType: "team",
          scopeId: "team-1",
        },
      }),
    ).toBe(true);

    expect(
      canDeleteMemory({
        requesterUserId: "user-1",
        requesterRole: "team-admin",
        organizationId: "org-1",
        requesterTeamIds: ["team-2"],
        item: {
          scopeType: "team",
          scopeId: "team-1",
        },
      }),
    ).toBe(false);
  });

  test("allows organization scope deletes only for org admins", () => {
    expect(
      canDeleteMemory({
        requesterUserId: "user-1",
        requesterRole: "admin",
        organizationId: "org-1",
        item: {
          scopeType: "organization",
          scopeId: "org-1",
        },
      }),
    ).toBe(true);

    expect(
      canDeleteMemory({
        requesterUserId: "user-1",
        requesterRole: "member",
        organizationId: "org-1",
        item: {
          scopeType: "organization",
          scopeId: "org-1",
        },
      }),
    ).toBe(false);

    expect(
      canDeleteMemory({
        requesterUserId: "user-1",
        requesterRole: "admin",
        organizationId: "org-1",
        item: {
          scopeType: "organization",
          scopeId: "org-2",
        },
      }),
    ).toBe(false);
  });
});
