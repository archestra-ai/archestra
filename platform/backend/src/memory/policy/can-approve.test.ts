import { describe, expect, test } from "vitest";
import { canApproveMemory } from "./can-approve";

describe("canApproveMemory", () => {
  test("allows user-scope approval for the owner", () => {
    const canApprove = canApproveMemory({
      requesterUserId: "user-1",
      requesterRole: "member",
      organizationId: "org-1",
      item: {
        scopeType: "user",
        scopeId: "user-1",
      },
    });

    expect(canApprove).toBe(true);
  });

  test("blocks user-scope approval for non-owner", () => {
    const canApprove = canApproveMemory({
      requesterUserId: "user-1",
      requesterRole: "member",
      organizationId: "org-1",
      item: {
        scopeType: "user",
        scopeId: "user-2",
      },
    });

    expect(canApprove).toBe(false);
  });

  test("allows team-scope approval for team-admin with membership", () => {
    const canApprove = canApproveMemory({
      requesterUserId: "user-1",
      requesterRole: "team-admin",
      organizationId: "org-1",
      requesterTeamIds: ["team-1"],
      item: {
        scopeType: "team",
        scopeId: "team-1",
      },
    });

    expect(canApprove).toBe(true);
  });

  test("blocks team-scope approval for team-admin without membership", () => {
    const canApprove = canApproveMemory({
      requesterUserId: "user-1",
      requesterRole: "team-admin",
      organizationId: "org-1",
      requesterTeamIds: ["team-2"],
      item: {
        scopeType: "team",
        scopeId: "team-1",
      },
    });

    expect(canApprove).toBe(false);
  });

  test("allows organization-scope approval for admin", () => {
    const canApprove = canApproveMemory({
      requesterUserId: "user-1",
      requesterRole: "admin",
      organizationId: "org-1",
      item: {
        scopeType: "organization",
        scopeId: "org-1",
      },
    });

    expect(canApprove).toBe(true);
  });

  test("blocks organization-scope approval for non-admin", () => {
    const canApprove = canApproveMemory({
      requesterUserId: "user-1",
      requesterRole: "team-admin",
      organizationId: "org-1",
      item: {
        scopeType: "organization",
        scopeId: "org-1",
      },
    });

    expect(canApprove).toBe(false);
  });
});
