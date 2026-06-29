import { expect } from "vitest";
import { test } from "@/test";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import McpCatalogTeamModel from "./mcp-catalog-team";

test("getUserAccessibleCatalogIds returns org-scoped items for any user", async ({
  makeUser,
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();

  const orgCatalog = await makeInternalMcpCatalog({
    scope: "org",
    organizationId: org.id,
  });

  const ids = await McpCatalogTeamModel.getUserAccessibleCatalogIds(
    user.id,
    false,
    org.id,
  );

  expect(ids).toContain(orgCatalog.id);
});

test("getUserAccessibleCatalogIds returns global org-scoped items for any user", async ({
  makeUser,
  makeOrganization,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();

  const globalCatalog = await InternalMcpCatalogModel.create({
    name: "global-catalog",
    serverType: "builtin",
    scope: "org",
  });

  const ids = await McpCatalogTeamModel.getUserAccessibleCatalogIds(
    user.id,
    false,
    org.id,
  );

  expect(ids).toContain(globalCatalog.id);
});

test("getUserAccessibleCatalogIds scopes org items to the active organization", async ({
  makeUser,
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();

  const orgCatalog = await makeInternalMcpCatalog({
    scope: "org",
    organizationId: org.id,
  });
  const otherOrgCatalog = await makeInternalMcpCatalog({
    scope: "org",
    organizationId: otherOrg.id,
  });

  const ids = await McpCatalogTeamModel.getUserAccessibleCatalogIds(
    user.id,
    false,
    org.id,
  );

  expect(ids).toContain(orgCatalog.id);
  expect(ids).not.toContain(otherOrgCatalog.id);
});

test("getUserAccessibleCatalogIds returns personal items only to author", async ({
  makeUser,
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const author = await makeUser();
  const otherUser = await makeUser();
  const org = await makeOrganization();

  const personalCatalog = await makeInternalMcpCatalog({
    scope: "personal",
    organizationId: org.id,
    authorId: author.id,
  });

  const authorIds = await McpCatalogTeamModel.getUserAccessibleCatalogIds(
    author.id,
    false,
    org.id,
  );
  expect(authorIds).toContain(personalCatalog.id);

  const otherIds = await McpCatalogTeamModel.getUserAccessibleCatalogIds(
    otherUser.id,
    false,
    org.id,
  );
  expect(otherIds).not.toContain(personalCatalog.id);
});

test("getUserAccessibleCatalogIds returns team items to team members", async ({
  makeUser,
  makeOrganization,
  makeTeam,
  makeTeamMember,
  makeInternalMcpCatalog,
}) => {
  const member = await makeUser();
  const nonMember = await makeUser();
  const org = await makeOrganization();
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
  const org = await makeOrganization();

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
  const org = await makeOrganization();

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
  const org = await makeOrganization();
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
    await McpCatalogTeamModel.userHasCatalogAccess(
      otherUser.id,
      orgCatalog.id,
      false,
      org.id,
    ),
  ).toBe(true);

  // Personal scope: only author
  expect(
    await McpCatalogTeamModel.userHasCatalogAccess(
      author.id,
      personalCatalog.id,
      false,
      org.id,
    ),
  ).toBe(true);
  expect(
    await McpCatalogTeamModel.userHasCatalogAccess(
      otherUser.id,
      personalCatalog.id,
      false,
      org.id,
    ),
  ).toBe(false);

  // Team scope: only team members
  expect(
    await McpCatalogTeamModel.userHasCatalogAccess(
      teamMember.id,
      teamCatalog.id,
      false,
      org.id,
    ),
  ).toBe(true);
  expect(
    await McpCatalogTeamModel.userHasCatalogAccess(
      otherUser.id,
      teamCatalog.id,
      false,
      org.id,
    ),
  ).toBe(false);

  // Admin: always has access
  expect(
    await McpCatalogTeamModel.userHasCatalogAccess(
      otherUser.id,
      personalCatalog.id,
      true,
      org.id,
    ),
  ).toBe(true);
});

test("userHasCatalogAccess denies org-scoped catalog items from other organizations", async ({
  makeUser,
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();
  const otherOrgCatalog = await makeInternalMcpCatalog({
    scope: "org",
    organizationId: otherOrg.id,
  });

  await expect(
    McpCatalogTeamModel.userHasCatalogAccess(
      user.id,
      otherOrgCatalog.id,
      true,
      org.id,
    ),
  ).resolves.toBe(false);
});

test("userHasCatalogAccess allows global org-scoped catalog items", async ({
  makeUser,
  makeOrganization,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();
  const globalCatalog = await InternalMcpCatalogModel.create({
    name: "global-access-catalog",
    serverType: "builtin",
    scope: "org",
  });

  await expect(
    McpCatalogTeamModel.userHasCatalogAccess(
      user.id,
      globalCatalog.id,
      false,
      org.id,
    ),
  ).resolves.toBe(true);
});

test("syncCatalogTeams replaces team assignments", async ({
  makeOrganization,
  makeUser,
  makeTeam,
  makeInternalMcpCatalog,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();
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

test("findAll with scope filtering returns correct items", async ({
  makeUser,
  makeOrganization,
  makeTeam,
  makeTeamMember,
  makeInternalMcpCatalog,
}) => {
  const author = await makeUser();
  const otherUser = await makeUser();
  const org = await makeOrganization();
  const team = await makeTeam(org.id, author.id);
  await makeTeamMember(team.id, author.id);

  const orgCatalog = await makeInternalMcpCatalog({
    scope: "org",
    organizationId: org.id,
    name: "scope-test-org",
  });
  const personalCatalog = await makeInternalMcpCatalog({
    scope: "personal",
    organizationId: org.id,
    authorId: author.id,
    name: "scope-test-personal",
  });
  const teamCatalog = await makeInternalMcpCatalog({
    scope: "team",
    organizationId: org.id,
    teams: [team.id],
    name: "scope-test-team",
  });

  // Author can see all 3
  const authorItems = await InternalMcpCatalogModel.findAll({
    expandSecrets: false,
    userId: author.id,
    isAdmin: false,
    organizationId: org.id,
  });
  const authorNames = authorItems.map((i) => i.name);
  expect(authorNames).toContain(orgCatalog.name);
  expect(authorNames).toContain(personalCatalog.name);
  expect(authorNames).toContain(teamCatalog.name);

  // Other user can only see org
  const otherItems = await InternalMcpCatalogModel.findAll({
    expandSecrets: false,
    userId: otherUser.id,
    isAdmin: false,
    organizationId: org.id,
  });
  const otherNames = otherItems.map((i) => i.name);
  expect(otherNames).toContain(orgCatalog.name);
  expect(otherNames).not.toContain(personalCatalog.name);
  expect(otherNames).not.toContain(teamCatalog.name);
});

test("findAll with scope filtering includes global org-scoped items", async ({
  makeUser,
  makeOrganization,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();
  const globalCatalog = await InternalMcpCatalogModel.create({
    name: "scope-test-global",
    serverType: "builtin",
    scope: "org",
  });

  const items = await InternalMcpCatalogModel.findAll({
    expandSecrets: false,
    userId: user.id,
    isAdmin: false,
    organizationId: org.id,
  });

  expect(items.map((i) => i.id)).toContain(globalCatalog.id);
});
