import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { SERVICE_ACCOUNT_USER_ID_PREFIX } from "@/auth/utils";
import { describe, expect, test } from "@/test";
import { filterToolsByCallerCatalogAccess } from "./caller-catalog-access";

describe("filterToolsByCallerCatalogAccess", () => {
  test("drops tools of catalog items a member cannot access and keeps the rest", async ({
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const member = await makeUser();
    await makeMember(owner.id, org.id, { role: "admin" });
    await makeMember(member.id, org.id, { role: "member" });
    const team = await makeTeam(org.id, owner.id);

    const teamCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: owner.id,
      scope: "team",
      teams: [team.id],
    });
    const orgCatalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tools = [
      { name: "team", catalogId: teamCatalog.id },
      { name: "org", catalogId: orgCatalog.id },
      { name: "builtin", catalogId: ARCHESTRA_MCP_CATALOG_ID },
      { name: "delegation", catalogId: null },
    ];

    const memberTools = await filterToolsByCallerCatalogAccess(tools, {
      userId: member.id,
      organizationId: org.id,
    });
    expect(memberTools.map((tool) => tool.name)).toEqual([
      "org",
      "builtin",
      "delegation",
    ]);

    // A registry admin reaches every catalog item, as in the registry list.
    const ownerTools = await filterToolsByCallerCatalogAccess(tools, {
      userId: owner.id,
      organizationId: org.id,
    });
    expect(ownerTools).toEqual(tools);
  });

  test("a team member reaches the team's catalog item", async ({
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const member = await makeUser();
    await makeMember(owner.id, org.id, { role: "admin" });
    await makeMember(member.id, org.id, { role: "member" });
    const team = await makeTeam(org.id, owner.id);
    await makeTeamMember(team.id, member.id);
    const teamCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: owner.id,
      scope: "team",
      teams: [team.id],
    });
    const tools = [{ name: "team", catalogId: teamCatalog.id }];

    expect(
      await filterToolsByCallerCatalogAccess(tools, {
        userId: member.id,
        organizationId: org.id,
      }),
    ).toEqual(tools);
  });

  test("leaves the assigned set whole for callers that are not users", async ({
    makeInternalMcpCatalog,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const privateCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
    });
    const tools = [{ name: "private", catalogId: privateCatalog.id }];

    for (const caller of [
      // Team and organization tokens carry no user.
      { organizationId: org.id },
      { userId: "system", organizationId: org.id },
      {
        userId: `${SERVICE_ACCOUNT_USER_ID_PREFIX}${crypto.randomUUID()}`,
        organizationId: org.id,
      },
    ]) {
      expect(await filterToolsByCallerCatalogAccess(tools, caller)).toEqual(
        tools,
      );
    }
  });
});
