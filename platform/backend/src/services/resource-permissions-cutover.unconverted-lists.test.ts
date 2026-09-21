// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import SkillTeamModel from "@/models/skill-team";
import { describe, expect, test } from "@/test";

/**
 * Lists that lost their role gate, asked before any policy exists.
 *
 * `GetSkills` and `GetInternalMcpCatalog` used to require `skill:read` and
 * `mcpRegistry:read` at the door. Object grants took that over, and both now
 * filter with `migratedAccessCondition` — whose unconverted branch is true for
 * every row, because it was written for lists that still had the role check in
 * front of them. Take the check away and leave nothing in its place and the
 * list is open to every role for as long as the policies are missing.
 *
 * Neither is open, because both routes put something in its place: skills pass
 * `onlyExplicitGrants` when the caller lacks `skill:read`, and the catalog
 * passes `readGrantContext` when the caller lacks `mcpRegistry:read`. Both
 * force an explicit grant instead of falling through to the legacy branch.
 * These tests pin that compensation, in the one state where its absence would
 * not show: an organization with no policy rows at all.
 */
describe("lists whose role gate moved to grants, before the conversion", () => {
  test("a skill list refuses a caller without the read action", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const { default: SkillModel } = await import("@/models/skill");
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        authorId: user.id,
        name: `unconverted-${crypto.randomUUID().slice(0, 8)}`,
        description: "Seeded for the unconverted-list check",
        content: "# Instructions",
        sourceType: "manual",
        // Organization-wide, so only the role action stands between this
        // caller and the row.
        scope: "org",
      },
      files: [],
    });
    if (!skill) throw new Error("failed to seed skill");

    // What the route passes when `skill:read` is absent.
    expect(
      await SkillTeamModel.getUserAccessibleSkillIds({
        organizationId: org.id,
        userId: user.id,
        onlyExplicitGrants: true,
        isSkillAdmin: false,
      }),
    ).toEqual([]);

    // ...and when it is present, so the assertion above is about the action
    // rather than about an empty organization.
    expect(
      await SkillTeamModel.getUserAccessibleSkillIds({
        organizationId: org.id,
        userId: user.id,
        onlyExplicitGrants: false,
        isSkillAdmin: false,
      }),
    ).toContain(skill.id);
  });

  test("a catalog list refuses a caller without the read action", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: user.id,
      scope: "org",
    });

    // What the route passes when `mcpRegistry:read` is absent.
    const withoutAction = await InternalMcpCatalogModel.findAll({
      expandSecrets: false,
      userId: user.id,
      isAdmin: false,
      organizationId: org.id,
      readGrantContext: { userId: user.id, organizationId: org.id },
    });
    expect(withoutAction.map((item) => item.id)).not.toContain(catalog.id);

    const withAction = await InternalMcpCatalogModel.findAll({
      expandSecrets: false,
      userId: user.id,
      isAdmin: false,
      organizationId: org.id,
    });
    expect(withAction.map((item) => item.id)).toContain(catalog.id);
  });
});
