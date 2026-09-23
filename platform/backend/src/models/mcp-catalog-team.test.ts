import { expect } from "vitest";
import { test } from "@/test";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import McpCatalogTeamModel from "./mcp-catalog-team";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

test("getUserAccessibleCatalogIds returns team items to team members", async ({
  makeUser,
  makeOrganization,
  makeTeam,
  makeTeamMember,
  makeInternalMcpCatalog,
}) => {
  const member = await makeUser();
  const nonMember = await makeUser();
  const org = await makeOrganization({ legacyPermissions: true });
  const team = await makeTeam(org.id, member.id);
  await makeTeamMember(team.id, member.id);

  const teamCatalog = await makeInternalMcpCatalog({
    scope: "team",
    organizationId: org.id,
    teams: [team.id],
  });

  const memberIds = await McpCatalogTeamModel.getUserAccessibleCatalogIds(
    member.id,
    false,
    org.id,
  );
  expect(memberIds).toContain(teamCatalog.id);

  const nonMemberIds = await McpCatalogTeamModel.getUserAccessibleCatalogIds(
    nonMember.id,
    false,
    org.id,
  );
  expect(nonMemberIds).not.toContain(teamCatalog.id);
});

test("getUserAccessibleCatalogIds returns all items for admin", async ({
  makeUser,
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const admin = await makeUser();
  const author = await makeUser();
  const org = await makeOrganization({ legacyPermissions: true });

  const personalCatalog = await makeInternalMcpCatalog({
    scope: "personal",
    organizationId: org.id,
    authorId: author.id,
  });

  const adminIds = await McpCatalogTeamModel.getUserAccessibleCatalogIds(
    admin.id,
    true,
    org.id,
  );
  expect(adminIds).toContain(personalCatalog.id);
});

test("getUserAccessibleCatalogIds returns global items for admin", async ({
  makeUser,
  makeOrganization,
}) => {
  const admin = await makeUser();
  const org = await makeOrganization({ legacyPermissions: true });

  const globalCatalog = await InternalMcpCatalogModel.create({
    name: "global-admin-catalog",
    serverType: "builtin",
    scope: "org",
  });

  const adminIds = await McpCatalogTeamModel.getUserAccessibleCatalogIds(
    admin.id,
    true,
    org.id,
  );

  expect(adminIds).toContain(globalCatalog.id);
});

test("userHasCatalogAccess checks access correctly for all scope types", async ({
  makeUser,
  makeOrganization,
  makeTeam,
  makeTeamMember,
  makeInternalMcpCatalog,
}) => {
  const author = await makeUser();
  const teamMember = await makeUser();
  const otherUser = await makeUser();
  const org = await makeOrganization({ legacyPermissions: true });
  const team = await makeTeam(org.id, author.id);
  await makeTeamMember(team.id, teamMember.id);

  const orgCatalog = await makeInternalMcpCatalog({
    scope: "org",
    organizationId: org.id,
  });
  const personalCatalog = await makeInternalMcpCatalog({
    scope: "personal",
    organizationId: org.id,
    authorId: author.id,
  });
  const teamCatalog = await makeInternalMcpCatalog({
    scope: "team",
    organizationId: org.id,
    teams: [team.id],
  });

  // Org scope: everyone has access
  expect(
    await McpCatalogTeamModel.userHasCatalogAccess({
      userId: otherUser.id,
      catalogId: orgCatalog.id,
      organizationId: org.id,
    }),
  ).toBe(true);

  // Personal scope: only author
  expect(
    await McpCatalogTeamModel.userHasCatalogAccess({
      userId: author.id,
      catalogId: personalCatalog.id,
      organizationId: org.id,
    }),
  ).toBe(true);
  expect(
    await McpCatalogTeamModel.userHasCatalogAccess({
      userId: otherUser.id,
      catalogId: personalCatalog.id,
      organizationId: org.id,
    }),
  ).toBe(false);

  // Team scope: only team members
  expect(
    await McpCatalogTeamModel.userHasCatalogAccess({
      userId: teamMember.id,
      catalogId: teamCatalog.id,
      organizationId: org.id,
    }),
  ).toBe(true);
  expect(
    await McpCatalogTeamModel.userHasCatalogAccess({
      userId: otherUser.id,
      catalogId: teamCatalog.id,
      organizationId: org.id,
    }),
  ).toBe(false);

  // Admin: always has access
  expect(
    await McpCatalogTeamModel.userHasCatalogAccess({
      userId: otherUser.id,
      catalogId: personalCatalog.id,
      organizationId: org.id,
    }),
  ).toBe(true);
});

test("userHasCatalogAccess denies org-scoped catalog items from other organizations", async ({
  makeUser,
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const user = await makeUser();
  const org = await makeOrganization({ legacyPermissions: true });
  const otherOrg = await makeOrganization({ legacyPermissions: true });
  const otherOrgCatalog = await makeInternalMcpCatalog({
    scope: "org",
    organizationId: otherOrg.id,
  });

  await expect(
    McpCatalogTeamModel.userHasCatalogAccess({
      userId: user.id,
      catalogId: otherOrgCatalog.id,
      organizationId: org.id,
    }),
  ).resolves.toBe(false);
});

test("userHasCatalogAccess treats global catalog items by their grants", async ({
  makeUser,
  makeMember,
  makeOrganization,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();
  await makeMember(user.id, org.id);
  const globalCatalog = await InternalMcpCatalogModel.create({
    name: "global-access-catalog",
    serverType: "builtin",
    scope: "org",
  });
  const check = () =>
    McpCatalogTeamModel.userHasCatalogAccess({
      userId: user.id,
      catalogId: globalCatalog.id,
      organizationId: org.id,
    });

  // Being global and org-scoped no longer lets anyone in by itself.
  await expect(check()).resolves.toBe(false);
  await ResourcePermissionPolicyModel.replace({
    organizationId: org.id,
    resource: "mcpRegistry",
    scope: globalCatalog.id,
    revision: 0,
    grants: [{ subject: { type: "user", id: user.id }, actions: ["read"] }],
  });
  await expect(check()).resolves.toBe(true);
});

test("syncCatalogTeams replaces team assignments", async ({
  makeOrganization,
  makeUser,
  makeTeam,
  makeInternalMcpCatalog,
}) => {
  const user = await makeUser();
  const org = await makeOrganization({ legacyPermissions: true });
  const team1 = await makeTeam(org.id, user.id);
  const team2 = await makeTeam(org.id, user.id);

  const catalog = await makeInternalMcpCatalog({
    scope: "team",
    organizationId: org.id,
    teams: [team1.id],
  });

  let teams = await McpCatalogTeamModel.getTeamDetailsForCatalog(catalog.id);
  expect(teams).toHaveLength(1);
  expect(teams[0].id).toBe(team1.id);

  // Replace with team2
  await McpCatalogTeamModel.syncCatalogTeams(catalog.id, [team2.id]);
  teams = await McpCatalogTeamModel.getTeamDetailsForCatalog(catalog.id);
  expect(teams).toHaveLength(1);
  expect(teams[0].id).toBe(team2.id);

  // Clear all
  await McpCatalogTeamModel.syncCatalogTeams(catalog.id, []);
  teams = await McpCatalogTeamModel.getTeamDetailsForCatalog(catalog.id);
  expect(teams).toHaveLength(0);
});

test("syncCatalogTeams stores an explicit level and reads it back", async ({
  makeOrganization,
  makeUser,
  makeTeam,
  makeInternalMcpCatalog,
}) => {
  const user = await makeUser();
  const org = await makeOrganization({ legacyPermissions: true });
  const team = await makeTeam(org.id, user.id);
  const catalog = await makeInternalMcpCatalog({
    scope: "team",
    organizationId: org.id,
    teams: [team.id],
  });

  await McpCatalogTeamModel.syncCatalogTeams(catalog.id, [
    { id: team.id, level: "use" },
  ]);

  const [detail] = await McpCatalogTeamModel.getTeamDetailsForCatalog(
    catalog.id,
  );
  expect(detail.level).toBe("use");
});

test("a team assigned with a bare id defaults to write", async ({
  makeOrganization,
  makeUser,
  makeTeam,
  makeInternalMcpCatalog,
}) => {
  const user = await makeUser();
  const org = await makeOrganization({ legacyPermissions: true });
  const team = await makeTeam(org.id, user.id);
  // A bare id carries no level, so it takes the column default.
  const catalog = await makeInternalMcpCatalog({
    scope: "team",
    organizationId: org.id,
    teams: [team.id],
  });

  const [detail] = await McpCatalogTeamModel.getTeamDetailsForCatalog(
    catalog.id,
  );
  expect(detail.level).toBe("write");
});

test("syncCatalogTeams preserves a stored level when re-synced with a bare id", async ({
  makeOrganization,
  makeUser,
  makeTeam,
  makeInternalMcpCatalog,
}) => {
  const user = await makeUser();
  const org = await makeOrganization({ legacyPermissions: true });
  const team = await makeTeam(org.id, user.id);
  const catalog = await makeInternalMcpCatalog({
    scope: "team",
    organizationId: org.id,
    teams: [{ id: team.id, level: "use" }],
  });

  // A level-less id must not reset the stored `use` back to the NULL default.
  await McpCatalogTeamModel.syncCatalogTeams(catalog.id, [team.id]);

  const [detail] = await McpCatalogTeamModel.getTeamDetailsForCatalog(
    catalog.id,
  );
  expect(detail.level).toBe("use");
});

test("syncCatalogTeams applies an explicit level over the stored one", async ({
  makeOrganization,
  makeUser,
  makeTeam,
  makeInternalMcpCatalog,
}) => {
  const user = await makeUser();
  const org = await makeOrganization({ legacyPermissions: true });
  const team = await makeTeam(org.id, user.id);
  const catalog = await makeInternalMcpCatalog({
    scope: "team",
    organizationId: org.id,
    teams: [{ id: team.id, level: "use" }],
  });

  await McpCatalogTeamModel.syncCatalogTeams(catalog.id, [
    { id: team.id, level: "write" },
  ]);

  const [detail] = await McpCatalogTeamModel.getTeamDetailsForCatalog(
    catalog.id,
  );
  expect(detail.level).toBe("write");
});

test("syncCatalogTeams honors a mixed list, preserving each team's stored level", async ({
  makeOrganization,
  makeUser,
  makeTeam,
  makeInternalMcpCatalog,
}) => {
  const user = await makeUser();
  const org = await makeOrganization({ legacyPermissions: true });
  const keep = await makeTeam(org.id, user.id);
  const added = await makeTeam(org.id, user.id);
  const catalog = await makeInternalMcpCatalog({
    scope: "team",
    organizationId: org.id,
    teams: [{ id: keep.id, level: "use" }],
  });

  // `keep` echoed as a bare id (preserve `use`), `added` as a new object.
  await McpCatalogTeamModel.syncCatalogTeams(catalog.id, [
    keep.id,
    { id: added.id, level: "write" },
  ]);

  const levels = Object.fromEntries(
    (await McpCatalogTeamModel.getTeamDetailsForCatalog(catalog.id)).map(
      (t) => [t.id, t.level],
    ),
  );
  expect(levels).toEqual({ [keep.id]: "use", [added.id]: "write" });
});

test("a catalog item is in front of the organization by its grants, not its retired scope", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeInternalMcpCatalog,
}) => {
  const org = await makeOrganization();
  const author = await makeUser();
  await makeMember(author.id, org.id);
  const item = await makeInternalMcpCatalog({
    organizationId: org.id,
    authorId: author.id,
    scope: "org",
  });
  const key = {
    organizationId: org.id,
    resource: "mcpRegistry" as const,
    scope: item.id,
  };
  const published = () =>
    McpCatalogTeamModel.isPublishedToOrganization({
      organizationId: org.id,
      catalog: item,
    });

  const policy = await ResourcePermissionPolicyModel.find(key);
  const authorOnly = await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy?.revision ?? 0,
    grants: (policy?.grants ?? []).filter(
      (grant) => grant.subject.type === "user",
    ),
  });
  expect(await published()).toBe(false);

  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: authorOnly?.revision ?? 0,
    grants: [
      ...(authorOnly?.grants ?? []),
      { subject: { type: "role", id: "member" }, actions: ["read", "use"] },
    ],
  });
  expect(await published()).toBe(true);
  expect(
    await McpCatalogTeamModel.isPublishedToOrganization({
      organizationId: org.id,
      catalog: { id: "00000000-0000-4000-8000-000000000002" },
    }),
  ).toBe(true);
});
