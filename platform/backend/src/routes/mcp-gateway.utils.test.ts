import { TeamTokenModel, UserTokenModel } from "@/models";
import { describe, expect, test } from "@/test";
import { validateMCPGatewayToken } from "./mcp-gateway.utils";

describe("validateMCPGatewayToken", () => {
  describe("invalid token scenarios", () => {
    test("returns null for invalid token", async () => {
      const result = await validateMCPGatewayToken(
        crypto.randomUUID(),
        "archestra_invalidtoken1234567890ab",
      );
      expect(result).toBeNull();
    });
  });

  describe("team token validation", () => {
    test("validates org token for any profile", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const { token, value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Org Token",
        teamId: null,
        isOrganizationToken: true,
      });

      const profileId = crypto.randomUUID();
      const result = await validateMCPGatewayToken(profileId, value);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(token.id);
      expect(result?.isOrganizationToken).toBe(true);
      expect(result?.teamId).toBeNull();
      expect(result?.organizationId).toBe(org.id);
    });

    test("validates team token when profile is assigned to that team", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Dev Team" });
      const agent = await makeAgent({ teams: [team.id] });

      const { token, value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Team Token",
        teamId: team.id,
      });

      const result = await validateMCPGatewayToken(agent.id, value);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(token.id);
      expect(result?.isOrganizationToken).toBe(false);
      expect(result?.teamId).toBe(team.id);
    });

    test("returns null when team token used for profile not in that team", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      // Agent assigned to team2 only
      const agent = await makeAgent({ teams: [team2.id] });

      // Token for team1
      const { value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Team 1 Token",
        teamId: team1.id,
      });

      const result = await validateMCPGatewayToken(agent.id, value);
      expect(result).toBeNull();
    });
  });

  describe("user token validation", () => {
    test("validates user token when user has team access to profile", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "member" });

      const team = await makeTeam(org.id, user.id, { name: "Dev Team" });
      await makeTeamMember(team.id, user.id);
      const agent = await makeAgent({ teams: [team.id] });

      const { token, value } = await UserTokenModel.create(
        user.id,
        org.id,
        "Personal Token",
      );

      const result = await validateMCPGatewayToken(agent.id, value);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(token.id);
      expect(result?.isUserToken).toBe(true);
      expect(result?.userId).toBe(user.id);
      expect(result?.organizationId).toBe(org.id);
    });

    test("returns null when user has no team access to profile", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user1 = await makeUser();
      const user2 = await makeUser();
      await makeMember(user1.id, org.id, { role: "member" });
      await makeMember(user2.id, org.id, { role: "member" });

      // user1 is in team1
      await makeTeam(org.id, user1.id, { name: "Team 1" });
      // user2 is in team2
      const team2 = await makeTeam(org.id, user2.id, { name: "Team 2" });

      // Agent is only assigned to team2
      const agent = await makeAgent({ teams: [team2.id] });

      // Create token for user1 (who is NOT in team2)
      const { value } = await UserTokenModel.create(
        user1.id,
        org.id,
        "User1 Token",
      );

      const result = await validateMCPGatewayToken(agent.id, value);
      expect(result).toBeNull();
    });

    test("admin user can access any profile regardless of team membership", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const adminUser = await makeUser();
      const regularUser = await makeUser();

      await makeMember(adminUser.id, org.id, { role: "admin" });
      await makeMember(regularUser.id, org.id, { role: "member" });

      // Create a team with regular user only (admin is NOT in this team)
      const team = await makeTeam(org.id, regularUser.id, {
        name: "Other Team",
      });

      // Agent assigned to team
      const agent = await makeAgent({ teams: [team.id] });

      // Create token for admin user
      const { token, value } = await UserTokenModel.create(
        adminUser.id,
        org.id,
        "Admin Token",
      );

      const result = await validateMCPGatewayToken(agent.id, value);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(token.id);
      expect(result?.isUserToken).toBe(true);
      expect(result?.userId).toBe(adminUser.id);
    });
  });

  describe("edge cases", () => {
    test("profile with no teams - team token fails, admin user token succeeds", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const adminUser = await makeUser();
      await makeMember(adminUser.id, org.id, { role: "admin" });

      // Agent with no teams
      const agent = await makeAgent({ teams: [] });

      // Create admin user token
      const { token, value } = await UserTokenModel.create(
        adminUser.id,
        org.id,
        "Admin Token",
      );

      const result = await validateMCPGatewayToken(agent.id, value);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(token.id);
      expect(result?.isUserToken).toBe(true);
    });

    test("user with no teams can only access profiles if admin", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const userWithNoTeams = await makeUser();
      const otherUser = await makeUser();

      await makeMember(userWithNoTeams.id, org.id, { role: "member" });
      await makeMember(otherUser.id, org.id, { role: "member" });

      // Create team with other user, agent in that team
      const team = await makeTeam(org.id, otherUser.id, { name: "Other Team" });
      const agent = await makeAgent({ teams: [team.id] });

      // Token for user with no teams
      const { value } = await UserTokenModel.create(
        userWithNoTeams.id,
        org.id,
        "No Teams Token",
      );

      const result = await validateMCPGatewayToken(agent.id, value);
      expect(result).toBeNull();
    });

    test("admin user with no teams can still access any profile", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const adminWithNoTeams = await makeUser();
      const otherUser = await makeUser();

      await makeMember(adminWithNoTeams.id, org.id, { role: "admin" });
      await makeMember(otherUser.id, org.id, { role: "member" });

      // Create team with other user, agent in that team
      const team = await makeTeam(org.id, otherUser.id, { name: "Other Team" });
      const agent = await makeAgent({ teams: [team.id] });

      // Token for admin with no teams
      const { token, value } = await UserTokenModel.create(
        adminWithNoTeams.id,
        org.id,
        "Admin No Teams Token",
      );

      const result = await validateMCPGatewayToken(agent.id, value);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(token.id);
      expect(result?.isUserToken).toBe(true);
      expect(result?.userId).toBe(adminWithNoTeams.id);
    });
  });
});
