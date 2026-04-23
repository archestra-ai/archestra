import { describe, expect, test } from "vitest";
import { canReadMemory } from "./can-read";

describe("canReadMemory", () => {
  test("allows reading user scope only for the owner", () => {
    expect(
      canReadMemory({
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
      canReadMemory({
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

  test("allows team scope for admin or matching team-admin", () => {
    expect(
      canReadMemory({
        requesterUserId: "user-1",
        requesterRole: "admin",
        organizationId: "org-1",
        requesterTeamIds: [],
        item: {
          scopeType: "team",
          scopeId: "team-1",
        },
      }),
    ).toBe(true);

    expect(
      canReadMemory({
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
      canReadMemory({
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

  test("hardens organization scope to admin only in same organization", () => {
    expect(
      canReadMemory({
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
      canReadMemory({
        requesterUserId: "user-1",
        requesterRole: "team-admin",
        organizationId: "org-1",
        item: {
          scopeType: "organization",
          scopeId: "org-1",
        },
      }),
    ).toBe(false);

    expect(
      canReadMemory({
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
