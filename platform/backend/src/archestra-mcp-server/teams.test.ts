// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { TeamModel } from "@/models";
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
