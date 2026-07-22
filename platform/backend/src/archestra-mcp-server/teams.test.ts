// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import { TeamLabelModel, TeamModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const toolName = (shortName: string) =>
  `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${shortName}`;

describe("team tool execution", () => {
  let testAgent: Agent;
  let organizationId: string;
  let adminUserId: string;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    adminUserId = user.id;
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({
      name: "Test Agent",
      organizationId: org.id,
    });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: org.id,
    };
  });

  // === create_team ===

  test("create_team returns error when name is missing", async () => {
    const result = await executeArchestraTool(
      toolName("create_team"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__create_team",
    );
    expect((result.content[0] as any).text).toContain("name:");
  });

  test("create_team succeeds and persists the team", async () => {
    const result = await executeArchestraTool(
      toolName("create_team"),
      { name: "Engineering", description: "The eng team" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully created team",
    );
    const team = (result.structuredContent as any).team;
    expect(team.name).toBe("Engineering");
    expect(team.description).toBe("The eng team");
    expect(team.organizationId).toBe(organizationId);
    expect(team.memberCount).toBe(0);

    const persisted = await TeamModel.findById(team.id);
    expect(persisted).not.toBeNull();
    expect(persisted?.name).toBe("Engineering");
  });

  test("create_team assigns labels at creation time", async () => {
    const result = await executeArchestraTool(
      toolName("create_team"),
      {
        name: "Platform",
        labels: [
          { key: "cost-center", value: "cc-123" },
          { key: "environment", value: "production" },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const team = (result.structuredContent as any).team;
    expect(team.labels).toEqual([
      { key: "cost-center", value: "cc-123" },
      { key: "environment", value: "production" },
    ]);
    expect((result.content[0] as any).text).toContain(
      "Labels: cost-center: cc-123, environment: production",
    );

    const persisted = await TeamLabelModel.getLabelsForTeam(team.id);
    expect(persisted.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "cost-center", value: "cc-123" },
      { key: "environment", value: "production" },
    ]);
  });

  test("create_team keeps one value per label key", async () => {
    const result = await executeArchestraTool(
      toolName("create_team"),
      {
        name: "Deduped",
        labels: [
          { key: "environment", value: "staging" },
          { key: "environment", value: "production" },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as any).team.labels).toEqual([
      { key: "environment", value: "production" },
    ]);
  });

  test("create_team rejects labels with reserved characters", async () => {
    const result = await executeArchestraTool(
      toolName("create_team"),
      { name: "Bad Labels", labels: [{ key: "a:b", value: "ok" }] },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__create_team",
    );
  });

  // === get_team ===

  test("get_team requires an id or name", async () => {
    const result = await executeArchestraTool(
      toolName("get_team"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Provide either an id or a name",
    );
  });

  test("get_team fetches by id", async ({ makeTeam }) => {
    const team = await makeTeam(organizationId, adminUserId, {
      name: "Support",
    });
    const result = await executeArchestraTool(
      toolName("get_team"),
      { id: team.id },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as any).team.name).toBe("Support");
  });

  test("get_team includes the team's labels", async ({ makeTeam }) => {
    const team = await makeTeam(organizationId, adminUserId, {
      name: "Labeled",
    });
    await TeamLabelModel.syncTeamLabels(team.id, [
      { key: "environment", value: "production" },
    ]);
    const result = await executeArchestraTool(
      toolName("get_team"),
      { id: team.id },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as any).team.labels).toEqual([
      { key: "environment", value: "production" },
    ]);
    expect((result.content[0] as any).text).toContain(
      "Labels: environment: production",
    );
  });

  test("get_team fetches by name", async ({ makeTeam }) => {
    await makeTeam(organizationId, adminUserId, { name: "Design" });
    const result = await executeArchestraTool(
      toolName("get_team"),
      { name: "Design" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as any).team.name).toBe("Design");
  });

  test("get_team returns error for a team in another organization", async ({
    makeTeam,
    makeUser,
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const otherUser = await makeUser();
    const otherTeam = await makeTeam(otherOrg.id, otherUser.id, {
      name: "Other Org Team",
    });
    const result = await executeArchestraTool(
      toolName("get_team"),
      { id: otherTeam.id },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("not found");
  });

  // === list_teams ===

  test("list_teams returns empty when no teams exist", async () => {
    const result = await executeArchestraTool(
      toolName("list_teams"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ teams: [] });
    expect((result.content[0] as any).text).toContain("No teams found");
  });

  test("list_teams returns teams and honors the name filter", async ({
    makeTeam,
  }) => {
    await makeTeam(organizationId, adminUserId, { name: "Alpha" });
    await makeTeam(organizationId, adminUserId, { name: "Beta" });

    const all = await executeArchestraTool(
      toolName("list_teams"),
      {},
      mockContext,
    );
    expect(all.isError).toBe(false);
    expect((all.structuredContent as any).teams).toHaveLength(2);

    const filtered = await executeArchestraTool(
      toolName("list_teams"),
      { name: "alph" },
      mockContext,
    );
    expect(filtered.isError).toBe(false);
    const teams = (filtered.structuredContent as any).teams;
    expect(teams).toHaveLength(1);
    expect(teams[0].name).toBe("Alpha");
  });

  test("list_teams includes each team's labels", async ({ makeTeam }) => {
    const labeled = await makeTeam(organizationId, adminUserId, {
      name: "Labeled",
    });
    await makeTeam(organizationId, adminUserId, { name: "Unlabeled" });
    await TeamLabelModel.syncTeamLabels(labeled.id, [
      { key: "cost-center", value: "cc-123" },
    ]);

    const result = await executeArchestraTool(
      toolName("list_teams"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    const teams = (result.structuredContent as any).teams;
    const byName = Object.fromEntries(
      teams.map((team: any) => [team.name, team.labels]),
    );
    expect(byName.Labeled).toEqual([{ key: "cost-center", value: "cc-123" }]);
    expect(byName.Unlabeled).toEqual([]);
  });

  test("list_teams only returns teams from the caller's organization", async ({
    makeTeam,
    makeUser,
    makeOrganization,
  }) => {
    await makeTeam(organizationId, adminUserId, { name: "Mine" });
    const otherOrg = await makeOrganization();
    const otherUser = await makeUser();
    await makeTeam(otherOrg.id, otherUser.id, { name: "Theirs" });

    const result = await executeArchestraTool(
      toolName("list_teams"),
      {},
      mockContext,
    );
    const teams = (result.structuredContent as any).teams;
    expect(teams).toHaveLength(1);
    expect(teams[0].name).toBe("Mine");
  });

  // === edit_team ===

  test("edit_team returns error when no fields provided", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const result = await executeArchestraTool(
      toolName("edit_team"),
      { id: team.id },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "No fields provided to update",
    );
  });

  test("edit_team updates name and description", async ({ makeTeam }) => {
    const team = await makeTeam(organizationId, adminUserId, {
      name: "Old Name",
    });
    const result = await executeArchestraTool(
      toolName("edit_team"),
      { id: team.id, name: "New Name", description: "Updated" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as any).team.name).toBe("New Name");

    const persisted = await TeamModel.findById(team.id);
    expect(persisted?.name).toBe("New Name");
    expect(persisted?.description).toBe("Updated");
  });

  test("edit_team clears the description when passed null", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, adminUserId, {
      name: "Has Desc",
      description: "to be cleared",
    });
    const result = await executeArchestraTool(
      toolName("edit_team"),
      { id: team.id, description: null },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const persisted = await TeamModel.findById(team.id);
    expect(persisted?.description).toBeNull();
  });

  test("edit_team replaces labels when provided", async ({ makeTeam }) => {
    const team = await makeTeam(organizationId, adminUserId, {
      name: "Relabel Me",
    });
    await TeamLabelModel.syncTeamLabels(team.id, [
      { key: "environment", value: "staging" },
      { key: "cost-center", value: "cc-old" },
    ]);

    const result = await executeArchestraTool(
      toolName("edit_team"),
      { id: team.id, labels: [{ key: "environment", value: "production" }] },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as any).team.labels).toEqual([
      { key: "environment", value: "production" },
    ]);

    const persisted = await TeamLabelModel.getLabelsForTeam(team.id);
    expect(persisted.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "environment", value: "production" },
    ]);
  });

  test("edit_team clears labels with an empty array and keeps them when omitted", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, adminUserId, {
      name: "Sticky Labels",
    });
    await TeamLabelModel.syncTeamLabels(team.id, [
      { key: "environment", value: "production" },
    ]);

    // A rename that omits labels must not touch them.
    const renamed = await executeArchestraTool(
      toolName("edit_team"),
      { id: team.id, name: "Renamed" },
      mockContext,
    );
    expect(renamed.isError).toBe(false);
    expect((renamed.structuredContent as any).team.labels).toEqual([
      { key: "environment", value: "production" },
    ]);

    const cleared = await executeArchestraTool(
      toolName("edit_team"),
      { id: team.id, labels: [] },
      mockContext,
    );
    expect(cleared.isError).toBe(false);
    expect((cleared.structuredContent as any).team.labels).toEqual([]);
    expect(await TeamLabelModel.getLabelsForTeam(team.id)).toEqual([]);
  });

  test("edit_team returns error for nonexistent team", async () => {
    const result = await executeArchestraTool(
      toolName("edit_team"),
      { id: crypto.randomUUID(), name: "Nope" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("not found");
  });

  // === delete_team ===

  test("delete_team deletes an existing team", async ({ makeTeam }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const result = await executeArchestraTool(
      toolName("delete_team"),
      { id: team.id },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully deleted team",
    );
    expect(await TeamModel.findById(team.id)).toBeNull();
  });

  test("delete_team returns error for nonexistent team", async () => {
    const result = await executeArchestraTool(
      toolName("delete_team"),
      { id: crypto.randomUUID() },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("not found");
  });

  // === list_team_members / add_team_member ===

  test("list_team_members lists members with roles", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const member = await makeUser({ email: "member@test.com" });
    await makeMember(member.id, organizationId, { role: "member" });
    await makeTeamMember(team.id, member.id, { role: "admin" });

    const result = await executeArchestraTool(
      toolName("list_team_members"),
      { team_id: team.id },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const members = (result.structuredContent as any).members;
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe(member.id);
    expect(members[0].role).toBe("admin");
    expect(members[0].email).toBe("member@test.com");
  });

  test("add_team_member adds an org user by email", async ({
    makeTeam,
    makeUser,
    makeMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const user = await makeUser({ email: "newmember@test.com" });
    await makeMember(user.id, organizationId, { role: "member" });

    const result = await executeArchestraTool(
      toolName("add_team_member"),
      { team_id: team.id, user: "newmember@test.com", role: "admin" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const member = (result.structuredContent as any).member;
    expect(member.userId).toBe(user.id);
    expect(member.role).toBe("admin");
    expect(await TeamModel.isUserInTeam(team.id, user.id)).toBe(true);
  });

  test("add_team_member defaults to the member role", async ({
    makeTeam,
    makeUser,
    makeMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const user = await makeUser({ email: "defaultrole@test.com" });
    await makeMember(user.id, organizationId, { role: "member" });

    const result = await executeArchestraTool(
      toolName("add_team_member"),
      { team_id: team.id, user: user.id },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as any).member.role).toBe("member");
  });

  test("add_team_member rejects a user not in the organization", async ({
    makeTeam,
    makeUser,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const outsider = await makeUser({ email: "outsider@test.com" });

    const result = await executeArchestraTool(
      toolName("add_team_member"),
      { team_id: team.id, user: outsider.id },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "found in this organization",
    );
  });

  test("add_team_member rejects an existing member", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const user = await makeUser({ email: "dupe@test.com" });
    await makeMember(user.id, organizationId, { role: "member" });
    await makeTeamMember(team.id, user.id, { role: "member" });

    const result = await executeArchestraTool(
      toolName("add_team_member"),
      { team_id: team.id, user: user.id },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "already a member of this team",
    );
  });

  // === update_team_member_role ===

  test("update_team_member_role changes a member's role", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const user = await makeUser({ email: "promote@test.com" });
    await makeMember(user.id, organizationId, { role: "member" });
    await makeTeamMember(team.id, user.id, { role: "member" });

    const result = await executeArchestraTool(
      toolName("update_team_member_role"),
      { team_id: team.id, user_id: user.id, role: "admin" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as any).member.role).toBe("admin");
  });

  test("update_team_member_role refuses to demote the last admin", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const soleAdmin = await makeUser({ email: "soleadmin@test.com" });
    await makeMember(soleAdmin.id, organizationId, { role: "member" });
    await makeTeamMember(team.id, soleAdmin.id, { role: "admin" });

    const result = await executeArchestraTool(
      toolName("update_team_member_role"),
      { team_id: team.id, user_id: soleAdmin.id, role: "member" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Cannot remove the last admin",
    );
  });

  // === remove_team_member ===

  test("remove_team_member removes a member", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const user = await makeUser({ email: "removeme@test.com" });
    await makeMember(user.id, organizationId, { role: "member" });
    await makeTeamMember(team.id, user.id, { role: "member" });

    const result = await executeArchestraTool(
      toolName("remove_team_member"),
      { team_id: team.id, user_id: user.id },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully removed member",
    );
    expect(await TeamModel.isUserInTeam(team.id, user.id)).toBe(false);
  });

  test("remove_team_member refuses to remove the last admin", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const soleAdmin = await makeUser({ email: "lastadmin@test.com" });
    await makeMember(soleAdmin.id, organizationId, { role: "member" });
    await makeTeamMember(team.id, soleAdmin.id, { role: "admin" });

    const result = await executeArchestraTool(
      toolName("remove_team_member"),
      { team_id: team.id, user_id: soleAdmin.id },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Cannot remove the last admin",
    );
  });

  // === RBAC ===

  test("create_team is denied without team:create permission", async ({
    makeUser,
    makeMember,
  }) => {
    const plainUser = await makeUser({ email: "plain@test.com" });
    await makeMember(plainUser.id, organizationId, { role: "member" });
    const memberContext: ArchestraContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: plainUser.id,
      organizationId,
    };

    const result = await executeArchestraTool(
      toolName("create_team"),
      { name: "Should Fail" },
      memberContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("do not have permission");
  });

  // === external groups (SSO team sync) ===

  test("list_team_external_groups returns the team's mappings", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, adminUserId, {
      name: "Synced",
    });
    await TeamModel.addExternalGroup(team.id, "okta-engineering");

    const result = await executeArchestraTool(
      toolName("list_team_external_groups"),
      { team_id: team.id },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const groups = (result.structuredContent as any).externalGroups;
    expect(groups).toHaveLength(1);
    expect(groups[0].groupIdentifier).toBe("okta-engineering");
    expect(groups[0].teamId).toBe(team.id);
    expect((result.content[0] as any).text).toContain("okta-engineering");
  });

  test("add_team_external_group maps a group and normalizes the identifier to lowercase", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, adminUserId, {
      name: "Sync Me",
    });
    const result = await executeArchestraTool(
      toolName("add_team_external_group"),
      { team_id: team.id, group_identifier: "CN=Admins,OU=Groups" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const group = (result.structuredContent as any).externalGroup;
    expect(group.groupIdentifier).toBe("cn=admins,ou=groups");

    const persisted = await TeamModel.getExternalGroups(team.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].groupIdentifier).toBe("cn=admins,ou=groups");
  });

  test("add_team_external_group rejects a duplicate mapping case-insensitively", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, adminUserId, {
      name: "Dup Sync",
    });
    await TeamModel.addExternalGroup(team.id, "okta-engineering");

    const result = await executeArchestraTool(
      toolName("add_team_external_group"),
      { team_id: team.id, group_identifier: "Okta-Engineering" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "already mapped to this team",
    );
  });

  test("remove_team_external_group requires a group_id or group_identifier", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const result = await executeArchestraTool(
      toolName("remove_team_external_group"),
      { team_id: team.id },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Provide either a group_id or a group_identifier",
    );
  });

  test("remove_team_external_group removes by mapping id and by identifier", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, adminUserId, {
      name: "Unsync",
    });
    const first = await TeamModel.addExternalGroup(team.id, "okta-first");
    await TeamModel.addExternalGroup(team.id, "okta-second");

    const byId = await executeArchestraTool(
      toolName("remove_team_external_group"),
      { team_id: team.id, group_id: first.id },
      mockContext,
    );
    expect(byId.isError).toBe(false);

    // Identifiers are matched case-insensitively on removal too.
    const byIdentifier = await executeArchestraTool(
      toolName("remove_team_external_group"),
      { team_id: team.id, group_identifier: "Okta-Second" },
      mockContext,
    );
    expect(byIdentifier.isError).toBe(false);
    expect(await TeamModel.getExternalGroups(team.id)).toHaveLength(0);

    const missing = await executeArchestraTool(
      toolName("remove_team_external_group"),
      { team_id: team.id, group_identifier: "okta-first" },
      mockContext,
    );
    expect(missing.isError).toBe(true);
    expect((missing.content[0] as any).text).toContain(
      "External group mapping not found",
    );
  });

  test("external group tools are blocked without an enterprise license", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const originalCore = config.enterpriseFeatures.core;
    Object.defineProperty(config.enterpriseFeatures, "core", {
      value: false,
      writable: true,
      configurable: true,
    });
    enterpriseTier.setUserCountForTesting(9999);
    try {
      const result = await executeArchestraTool(
        toolName("add_team_external_group"),
        { team_id: team.id, group_identifier: "okta-engineering" },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Team Sync is an enterprise feature",
      );
    } finally {
      Object.defineProperty(config.enterpriseFeatures, "core", {
        value: originalCore,
        writable: true,
        configurable: true,
      });
      enterpriseTier.setUserCountForTesting(0);
    }
  });

  test("a plain team member cannot manage external group sync", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId, {
      name: "Locked Sync",
    });
    const plainUser = await makeUser({ email: "plain-sync@test.com" });
    await makeMember(plainUser.id, organizationId, { role: "member" });
    await makeTeamMember(team.id, plainUser.id, { role: "member" });
    const memberContext: ArchestraContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: plainUser.id,
      organizationId,
    };

    const result = await executeArchestraTool(
      toolName("add_team_external_group"),
      { team_id: team.id, group_identifier: "okta-engineering" },
      memberContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "manage this team's external group sync",
    );
  });

  // === Team-admin management (org member who is admin of a specific team) ===

  /**
   * Builds a context for an org "member" (holds team:read, not team:update /
   * team:create) who is a team admin of `teamId`. This is the scenario the REST
   * `assertCanManageTeam` allows and which org-level RBAC alone would block.
   */
  async function makeTeamAdminContext(params: {
    teamId: string;
    email: string;
    makeUser: any;
    makeMember: any;
    makeTeamMember: any;
  }): Promise<{ context: ArchestraContext; userId: string }> {
    const user = await params.makeUser({ email: params.email });
    await params.makeMember(user.id, organizationId, { role: "member" });
    await params.makeTeamMember(params.teamId, user.id, { role: "admin" });
    return {
      userId: user.id,
      context: {
        agent: { id: testAgent.id, name: testAgent.name },
        userId: user.id,
        organizationId,
      },
    };
  }

  test("a team admin (org member) can add a member to their own team", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const { context } = await makeTeamAdminContext({
      teamId: team.id,
      email: "teamadmin-add@test.com",
      makeUser,
      makeMember,
      makeTeamMember,
    });

    const target = await makeUser({ email: "added-by-teamadmin@test.com" });
    await makeMember(target.id, organizationId, { role: "member" });

    const result = await executeArchestraTool(
      toolName("add_team_member"),
      { team_id: team.id, user: target.id },
      context,
    );
    expect(result.isError).toBe(false);
    expect(await TeamModel.isUserInTeam(team.id, target.id)).toBe(true);
  });

  test("a team admin (org member) can update a member's role in their team", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const { context } = await makeTeamAdminContext({
      teamId: team.id,
      email: "teamadmin-update@test.com",
      makeUser,
      makeMember,
      makeTeamMember,
    });

    const target = await makeUser({ email: "role-target@test.com" });
    await makeMember(target.id, organizationId, { role: "member" });
    await makeTeamMember(team.id, target.id, { role: "member" });

    const result = await executeArchestraTool(
      toolName("update_team_member_role"),
      { team_id: team.id, user_id: target.id, role: "admin" },
      context,
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as any).member.role).toBe("admin");
  });

  test("a team admin (org member) can remove a member from their team", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const { context } = await makeTeamAdminContext({
      teamId: team.id,
      email: "teamadmin-remove@test.com",
      makeUser,
      makeMember,
      makeTeamMember,
    });

    const target = await makeUser({ email: "remove-target@test.com" });
    await makeMember(target.id, organizationId, { role: "member" });
    await makeTeamMember(team.id, target.id, { role: "member" });

    const result = await executeArchestraTool(
      toolName("remove_team_member"),
      { team_id: team.id, user_id: target.id },
      context,
    );
    expect(result.isError).toBe(false);
    expect(await TeamModel.isUserInTeam(team.id, target.id)).toBe(false);
  });

  test("a plain team member (not admin) cannot manage team members", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const member = await makeUser({ email: "plainmember@test.com" });
    await makeMember(member.id, organizationId, { role: "member" });
    await makeTeamMember(team.id, member.id, { role: "member" });
    const memberContext: ArchestraContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: member.id,
      organizationId,
    };

    const target = await makeUser({ email: "wont-be-added@test.com" });
    await makeMember(target.id, organizationId, { role: "member" });

    const result = await executeArchestraTool(
      toolName("add_team_member"),
      { team_id: team.id, user: target.id },
      memberContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("must be a team admin");
    expect(await TeamModel.isUserInTeam(team.id, target.id)).toBe(false);
  });

  test("a team admin cannot manage a team they are not an admin of", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const teamA = await makeTeam(organizationId, adminUserId, { name: "A" });
    const teamB = await makeTeam(organizationId, adminUserId, { name: "B" });
    // Admin of team A only.
    const { context } = await makeTeamAdminContext({
      teamId: teamA.id,
      email: "admin-of-a@test.com",
      makeUser,
      makeMember,
      makeTeamMember,
    });

    const target = await makeUser({ email: "cross-team-target@test.com" });
    await makeMember(target.id, organizationId, { role: "member" });

    const result = await executeArchestraTool(
      toolName("add_team_member"),
      { team_id: teamB.id, user: target.id },
      context,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("must be a team admin");
  });

  // === Read scoping for non-managers ===

  test("a team member (org member) can read their own team", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId, { name: "Mine" });
    const member = await makeUser({ email: "reader-member@test.com" });
    await makeMember(member.id, organizationId, { role: "member" });
    await makeTeamMember(team.id, member.id, { role: "member" });
    const memberContext: ArchestraContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: member.id,
      organizationId,
    };

    const getResult = await executeArchestraTool(
      toolName("get_team"),
      { id: team.id },
      memberContext,
    );
    expect(getResult.isError).toBe(false);
    expect((getResult.structuredContent as any).team.name).toBe("Mine");

    const membersResult = await executeArchestraTool(
      toolName("list_team_members"),
      { team_id: team.id },
      memberContext,
    );
    expect(membersResult.isError).toBe(false);
  });

  test("a non-manager org member cannot read a team they don't belong to", async ({
    makeTeam,
    makeUser,
    makeMember,
  }) => {
    const team = await makeTeam(organizationId, adminUserId);
    const outsider = await makeUser({ email: "org-outsider@test.com" });
    await makeMember(outsider.id, organizationId, { role: "member" });
    const outsiderContext: ArchestraContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: outsider.id,
      organizationId,
    };

    const getResult = await executeArchestraTool(
      toolName("get_team"),
      { id: team.id },
      outsiderContext,
    );
    expect(getResult.isError).toBe(true);
    expect((getResult.content[0] as any).text).toContain("not found");

    const membersResult = await executeArchestraTool(
      toolName("list_team_members"),
      { team_id: team.id },
      outsiderContext,
    );
    expect(membersResult.isError).toBe(true);
    expect((membersResult.content[0] as any).text).toContain("not found");
  });

  test("list_teams returns only the caller's teams for a non-manager", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const myTeam = await makeTeam(organizationId, adminUserId, {
      name: "Belongs",
    });
    await makeTeam(organizationId, adminUserId, { name: "NotMine" });
    const member = await makeUser({ email: "scoped-list@test.com" });
    await makeMember(member.id, organizationId, { role: "member" });
    await makeTeamMember(myTeam.id, member.id, { role: "member" });
    const memberContext: ArchestraContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: member.id,
      organizationId,
    };

    const result = await executeArchestraTool(
      toolName("list_teams"),
      {},
      memberContext,
    );
    expect(result.isError).toBe(false);
    const teams = (result.structuredContent as any).teams;
    expect(teams).toHaveLength(1);
    expect(teams[0].name).toBe("Belongs");
  });

  // === full lifecycle ===

  test("full team CRUD + membership lifecycle", async ({
    makeUser,
    makeMember,
  }) => {
    // Create
    const createResult = await executeArchestraTool(
      toolName("create_team"),
      { name: "Lifecycle Team" },
      mockContext,
    );
    expect(createResult.isError).toBe(false);
    const teamId = (createResult.structuredContent as any).team.id;

    // Add a member
    const user = await makeUser({ email: "lifecycle@test.com" });
    await makeMember(user.id, organizationId, { role: "member" });
    const addResult = await executeArchestraTool(
      toolName("add_team_member"),
      { team_id: teamId, user: user.id, role: "member" },
      mockContext,
    );
    expect(addResult.isError).toBe(false);

    // Promote to admin
    const promoteResult = await executeArchestraTool(
      toolName("update_team_member_role"),
      { team_id: teamId, user_id: user.id, role: "admin" },
      mockContext,
    );
    expect(promoteResult.isError).toBe(false);

    // List members reflects the change
    const listResult = await executeArchestraTool(
      toolName("list_team_members"),
      { team_id: teamId },
      mockContext,
    );
    expect((listResult.structuredContent as any).members[0].role).toBe("admin");

    // get_team reports the member count
    const getResult = await executeArchestraTool(
      toolName("get_team"),
      { id: teamId },
      mockContext,
    );
    expect((getResult.structuredContent as any).team.memberCount).toBe(1);

    // Delete
    const deleteResult = await executeArchestraTool(
      toolName("delete_team"),
      { id: teamId },
      mockContext,
    );
    expect(deleteResult.isError).toBe(false);
    expect(await TeamModel.findById(teamId)).toBeNull();
  });
});
