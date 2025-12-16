import { MEMBER_ROLE_NAME } from "@shared";
import { describe, expect, test } from "@/test";
import TeamModel from "./team";

describe("TeamModel", () => {
  describe("create", () => {
    test("should create a team", async ({ makeUser, makeOrganization }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const team = await TeamModel.create({
        name: "Engineering",
        description: "Engineering team",
        organizationId: org.id,
        createdBy: user.id,
      });

      expect(team.id).toBeDefined();
      expect(team.name).toBe("Engineering");
      expect(team.description).toBe("Engineering team");
      expect(team.organizationId).toBe(org.id);
      expect(team.members).toEqual([]);
    });
  });

  describe("addMember", () => {
    test("should add a member to a team", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      const newUser = await makeUser({ email: "new@test.com" });
      const member = await TeamModel.addMember(team.id, newUser.id);

      expect(member.teamId).toBe(team.id);
      expect(member.userId).toBe(newUser.id);
      expect(member.role).toBe(MEMBER_ROLE_NAME);
      expect(member.syncedFromSso).toBe(false);
    });

    test("should add a member with syncedFromSso flag", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      const newUser = await makeUser({ email: "sso@test.com" });
      const member = await TeamModel.addMember(
        team.id,
        newUser.id,
        MEMBER_ROLE_NAME,
        true,
      );

      expect(member.syncedFromSso).toBe(true);
    });
  });

  describe("findByIds", () => {
    test("should find multiple teams by IDs", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });
      const _team3 = await makeTeam(org.id, user.id, { name: "Team 3" });

      const teams = await TeamModel.findByIds([team1.id, team2.id]);

      expect(teams).toHaveLength(2);
      expect(teams.map((t) => t.id).sort()).toEqual(
        [team1.id, team2.id].sort(),
      );
    });

    test("should return empty array for empty IDs array", async () => {
      const teams = await TeamModel.findByIds([]);

      expect(teams).toEqual([]);
    });

    test("should return empty array for non-existent IDs", async () => {
      const teams = await TeamModel.findByIds([
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]);

      expect(teams).toEqual([]);
    });

    test("should return teams without members for performance", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      // Add a member to the team
      const newUser = await makeUser({ email: "member@test.com" });
      await TeamModel.addMember(team.id, newUser.id);

      const teams = await TeamModel.findByIds([team.id]);

      expect(teams).toHaveLength(1);
      // Members should be empty array for performance
      expect(teams[0].members).toEqual([]);
    });
  });

  describe("getSsoSyncedMemberships", () => {
    test("should return SSO synced memberships for a user in an organization", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      // Add user with SSO sync to both teams
      const ssoUser = await makeUser({ email: "sso@test.com" });
      await TeamModel.addMember(team1.id, ssoUser.id, MEMBER_ROLE_NAME, true);
      await TeamModel.addMember(team2.id, ssoUser.id, MEMBER_ROLE_NAME, true);

      const memberships = await TeamModel.getSsoSyncedMemberships(
        ssoUser.id,
        org.id,
      );

      expect(memberships).toHaveLength(2);
      expect(memberships.every((m) => m.teamMember.syncedFromSso)).toBe(true);
    });

    test("should not return manually added memberships", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      // Add user manually (not SSO synced)
      const manualUser = await makeUser({ email: "manual@test.com" });
      await TeamModel.addMember(
        team.id,
        manualUser.id,
        MEMBER_ROLE_NAME,
        false,
      );

      const memberships = await TeamModel.getSsoSyncedMemberships(
        manualUser.id,
        org.id,
      );

      expect(memberships).toHaveLength(0);
    });

    test("should only return memberships for the specified organization", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org1 = await makeOrganization({ name: "Org 1" });
      const org2 = await makeOrganization({ name: "Org 2" });
      const team1 = await makeTeam(org1.id, user.id, { name: "Team in Org 1" });
      const team2 = await makeTeam(org2.id, user.id, { name: "Team in Org 2" });

      const ssoUser = await makeUser({ email: "sso@test.com" });
      await TeamModel.addMember(team1.id, ssoUser.id, MEMBER_ROLE_NAME, true);
      await TeamModel.addMember(team2.id, ssoUser.id, MEMBER_ROLE_NAME, true);

      const membershipsOrg1 = await TeamModel.getSsoSyncedMemberships(
        ssoUser.id,
        org1.id,
      );
      const membershipsOrg2 = await TeamModel.getSsoSyncedMemberships(
        ssoUser.id,
        org2.id,
      );

      expect(membershipsOrg1).toHaveLength(1);
      expect(membershipsOrg1[0].team.id).toBe(team1.id);
      expect(membershipsOrg2).toHaveLength(1);
      expect(membershipsOrg2[0].team.id).toBe(team2.id);
    });
  });

  // ==========================================
  // External Group Sync Tests
  // ==========================================

  describe("getExternalGroups", () => {
    test("should return empty array when no groups are linked", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      const groups = await TeamModel.getExternalGroups(team.id);

      expect(groups).toEqual([]);
    });
  });

  describe("addExternalGroup", () => {
    test("should add an external group mapping", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      const group = await TeamModel.addExternalGroup(team.id, "engineering");

      expect(group.id).toBeDefined();
      expect(group.teamId).toBe(team.id);
      expect(group.groupIdentifier).toBe("engineering");
      expect(group.createdAt).toBeDefined();
    });

    test("should allow same group identifier for different teams", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      const group1 = await TeamModel.addExternalGroup(team1.id, "admins");
      const group2 = await TeamModel.addExternalGroup(team2.id, "admins");

      expect(group1.groupIdentifier).toBe("admins");
      expect(group2.groupIdentifier).toBe("admins");
      expect(group1.teamId).not.toBe(group2.teamId);
    });
  });

  describe("removeExternalGroup", () => {
    test("should remove an external group mapping", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      await TeamModel.addExternalGroup(team.id, "engineering");

      // Verify group was added
      let groups = await TeamModel.getExternalGroups(team.id);
      expect(groups).toHaveLength(1);

      await TeamModel.removeExternalGroup(team.id, "engineering");

      // Verify group was removed
      groups = await TeamModel.getExternalGroups(team.id);
      expect(groups).toEqual([]);
    });

    test("should handle non-existent group gracefully", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      // Should not throw when removing non-existent group
      await TeamModel.removeExternalGroup(team.id, "non-existent");

      const groups = await TeamModel.getExternalGroups(team.id);
      expect(groups).toEqual([]);
    });
  });

  describe("removeExternalGroupById", () => {
    test("should remove an external group mapping by ID", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      const group = await TeamModel.addExternalGroup(team.id, "engineering");

      // Verify group was added
      let groups = await TeamModel.getExternalGroups(team.id);
      expect(groups).toHaveLength(1);

      await TeamModel.removeExternalGroupById(team.id, group.id);

      // Verify group was removed
      groups = await TeamModel.getExternalGroups(team.id);
      expect(groups).toEqual([]);
    });

    test("should not remove external group from different team (IDOR protection)", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      // Add group to team2
      const group = await TeamModel.addExternalGroup(team2.id, "engineering");

      // Try to delete using team1's ID but team2's group ID - should fail
      const result = await TeamModel.removeExternalGroupById(
        team1.id,
        group.id,
      );
      expect(result).toBe(false);

      // Verify group still exists on team2
      const groups = await TeamModel.getExternalGroups(team2.id);
      expect(groups).toHaveLength(1);
    });
  });

  describe("findTeamsByExternalGroup", () => {
    test("should find teams by external group", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      await TeamModel.addExternalGroup(team1.id, "engineering");
      await TeamModel.addExternalGroup(team2.id, "engineering");

      const teams = await TeamModel.findTeamsByExternalGroup(
        org.id,
        "engineering",
      );

      expect(teams).toHaveLength(2);
      expect(teams.map((t) => t.id).sort()).toEqual(
        [team1.id, team2.id].sort(),
      );
    });

    test("should perform case-insensitive matching", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      await TeamModel.addExternalGroup(team.id, "engineering");

      const teams = await TeamModel.findTeamsByExternalGroup(
        org.id,
        "ENGINEERING",
      );

      expect(teams).toHaveLength(1);
      expect(teams[0].id).toBe(team.id);
    });

    test("should only find teams in the specified organization", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org1 = await makeOrganization({ name: "Org 1" });
      const org2 = await makeOrganization({ name: "Org 2" });
      const team1 = await makeTeam(org1.id, user.id, { name: "Team in Org 1" });
      const team2 = await makeTeam(org2.id, user.id, { name: "Team in Org 2" });

      await TeamModel.addExternalGroup(team1.id, "shared-group");
      await TeamModel.addExternalGroup(team2.id, "shared-group");

      const teamsInOrg1 = await TeamModel.findTeamsByExternalGroup(
        org1.id,
        "shared-group",
      );
      const teamsInOrg2 = await TeamModel.findTeamsByExternalGroup(
        org2.id,
        "shared-group",
      );

      expect(teamsInOrg1).toHaveLength(1);
      expect(teamsInOrg1[0].id).toBe(team1.id);
      expect(teamsInOrg2).toHaveLength(1);
      expect(teamsInOrg2[0].id).toBe(team2.id);
    });
  });

  describe("findTeamsByExternalGroups", () => {
    test("should find teams by multiple external groups", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Engineering" });
      const team2 = await makeTeam(org.id, user.id, { name: "Product" });
      const team3 = await makeTeam(org.id, user.id, { name: "Design" });

      await TeamModel.addExternalGroup(team1.id, "engineering");
      await TeamModel.addExternalGroup(team2.id, "product");
      await TeamModel.addExternalGroup(team3.id, "design");

      const groupToTeams = await TeamModel.findTeamsByExternalGroups(org.id, [
        "engineering",
        "product",
      ]);

      expect(groupToTeams.size).toBe(2);
      expect(groupToTeams.get("engineering")).toHaveLength(1);
      expect(groupToTeams.get("product")).toHaveLength(1);
      expect(groupToTeams.has("design")).toBe(false);
    });

    test("should return empty map for empty groups array", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const groupToTeams = await TeamModel.findTeamsByExternalGroups(
        org.id,
        [],
      );

      expect(groupToTeams.size).toBe(0);
    });
  });

  describe("getTeammateUserIds", () => {
    test("should return empty array when user is not in any team", async ({
      makeUser,
    }) => {
      const user = await makeUser();

      const teammateIds = await TeamModel.getTeammateUserIds(user.id);

      expect(teammateIds).toEqual([]);
    });

    test("should return teammates from all teams the user belongs to", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      // Add the main user to both teams
      await TeamModel.addMember(team1.id, user.id);
      await TeamModel.addMember(team2.id, user.id);

      // Add other users to teams
      const teammate1 = await makeUser({ email: "teammate1@test.com" });
      const teammate2 = await makeUser({ email: "teammate2@test.com" });
      const teammate3 = await makeUser({ email: "teammate3@test.com" });

      await TeamModel.addMember(team1.id, teammate1.id); // In team1 only
      await TeamModel.addMember(team2.id, teammate2.id); // In team2 only
      await TeamModel.addMember(team1.id, teammate3.id); // In team1
      await TeamModel.addMember(team2.id, teammate3.id); // And team2

      const teammateIds = await TeamModel.getTeammateUserIds(user.id);

      // Should return all 3 teammates (deduplicated)
      expect(teammateIds).toHaveLength(3);
      expect(teammateIds).toContain(teammate1.id);
      expect(teammateIds).toContain(teammate2.id);
      expect(teammateIds).toContain(teammate3.id);
      // Should NOT include the user themselves
      expect(teammateIds).not.toContain(user.id);
    });

    test("should not include the user themselves", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      // Add the user to the team
      await TeamModel.addMember(team.id, user.id);

      const teammateIds = await TeamModel.getTeammateUserIds(user.id);

      // Should not include the user themselves
      expect(teammateIds).not.toContain(user.id);
      expect(teammateIds).toEqual([]);
    });

    test("should return unique user IDs (deduplicated)", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      // Add user to both teams
      await TeamModel.addMember(team1.id, user.id);
      await TeamModel.addMember(team2.id, user.id);

      // Add same teammate to both teams
      const sharedTeammate = await makeUser({ email: "shared@test.com" });
      await TeamModel.addMember(team1.id, sharedTeammate.id);
      await TeamModel.addMember(team2.id, sharedTeammate.id);

      const teammateIds = await TeamModel.getTeammateUserIds(user.id);

      // Should only appear once even though they're in both teams
      expect(teammateIds).toHaveLength(1);
      expect(teammateIds).toContain(sharedTeammate.id);
    });
  });

  describe("checkTeamAccess", () => {
    test("should allow access for team admin regardless of membership", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      // Admin user who is NOT a member of the team
      const adminUser = await makeUser({ email: "admin@test.com" });

      // Should not throw - admin has full access
      await expect(
        TeamModel.checkTeamAccess({
          userId: adminUser.id,
          teamId: team.id,
          isTeamAdmin: true,
        }),
      ).resolves.toBeUndefined();
    });

    test("should allow access for non-admin who is a team member", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      // Add a member to the team
      const memberUser = await makeUser({ email: "member@test.com" });
      await TeamModel.addMember(team.id, memberUser.id);

      // Should not throw - user is a member
      await expect(
        TeamModel.checkTeamAccess({
          userId: memberUser.id,
          teamId: team.id,
          isTeamAdmin: false,
        }),
      ).resolves.toBeUndefined();
    });

    test("should deny access for non-admin who is not a team member", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      // Non-member, non-admin user
      const outsiderUser = await makeUser({ email: "outsider@test.com" });

      // Should throw 403 error
      await expect(
        TeamModel.checkTeamAccess({
          userId: outsiderUser.id,
          teamId: team.id,
          isTeamAdmin: false,
        }),
      ).rejects.toThrow("Not authorized to access this team");
    });

    test("should throw ApiError with 403 status for unauthorized access", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      const outsiderUser = await makeUser({ email: "outsider@test.com" });

      try {
        await TeamModel.checkTeamAccess({
          userId: outsiderUser.id,
          teamId: team.id,
          isTeamAdmin: false,
        });
        // Should not reach here
        expect.fail("Expected checkTeamAccess to throw an error");
      } catch (error) {
        expect(error).toHaveProperty("statusCode", 403);
        expect(error).toHaveProperty(
          "message",
          "Not authorized to access this team",
        );
      }
    });
  });

  describe("getUserTeamIds", () => {
    test("should return empty array when user is not in any team", async ({
      makeUser,
    }) => {
      const user = await makeUser();

      const teamIds = await TeamModel.getUserTeamIds(user.id);

      expect(teamIds).toEqual([]);
    });

    test("should return all team IDs the user belongs to", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });
      const _team3 = await makeTeam(org.id, user.id, { name: "Team 3" });

      // Add user to team1 and team2, but not team3
      await TeamModel.addMember(team1.id, user.id);
      await TeamModel.addMember(team2.id, user.id);

      const teamIds = await TeamModel.getUserTeamIds(user.id);

      expect(teamIds).toHaveLength(2);
      expect(teamIds.sort()).toEqual([team1.id, team2.id].sort());
    });

    test("should return team IDs from multiple organizations", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const admin = await makeUser();
      const org1 = await makeOrganization({ name: "Org 1" });
      const org2 = await makeOrganization({ name: "Org 2" });
      const team1 = await makeTeam(org1.id, admin.id, {
        name: "Team in Org 1",
      });
      const team2 = await makeTeam(org2.id, admin.id, {
        name: "Team in Org 2",
      });

      // Add user to both teams
      await TeamModel.addMember(team1.id, user.id);
      await TeamModel.addMember(team2.id, user.id);

      const teamIds = await TeamModel.getUserTeamIds(user.id);

      expect(teamIds).toHaveLength(2);
      expect(teamIds).toContain(team1.id);
      expect(teamIds).toContain(team2.id);
    });
  });

  describe("syncUserTeams", () => {
    test("should add user to teams based on their SSO groups", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id, { name: "Engineering" });

      // Create a new user to sync
      const newUser = await makeUser({ email: "sso-user@test.com" });

      await TeamModel.addExternalGroup(team.id, "engineering");

      const { added, removed } = await TeamModel.syncUserTeams(
        newUser.id,
        org.id,
        ["engineering"],
      );

      expect(added).toContain(team.id);
      expect(removed).toHaveLength(0);

      // Verify user is now a member
      const isMember = await TeamModel.isUserInTeam(team.id, newUser.id);
      expect(isMember).toBe(true);
    });

    test("should not add user if already a member", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id, { name: "Engineering" });

      // Add user to team manually
      const newUser = await makeUser({ email: "existing@test.com" });
      await TeamModel.addMember(team.id, newUser.id);

      await TeamModel.addExternalGroup(team.id, "engineering");

      const { added, removed } = await TeamModel.syncUserTeams(
        newUser.id,
        org.id,
        ["engineering"],
      );

      expect(added).toHaveLength(0);
      expect(removed).toHaveLength(0);
    });

    test("should remove user from teams they were synced to but no longer have groups for", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Engineering" });
      const team2 = await makeTeam(org.id, user.id, { name: "Product" });

      await TeamModel.addExternalGroup(team1.id, "engineering");
      await TeamModel.addExternalGroup(team2.id, "product");

      // Create user with both groups initially
      const ssoUser = await makeUser({ email: "sso@test.com" });
      await TeamModel.addMember(team1.id, ssoUser.id, MEMBER_ROLE_NAME, true);
      await TeamModel.addMember(team2.id, ssoUser.id, MEMBER_ROLE_NAME, true);

      // Sync with only one group (simulating group membership change)
      const { added, removed } = await TeamModel.syncUserTeams(
        ssoUser.id,
        org.id,
        ["engineering"],
      );

      expect(added).toHaveLength(0);
      expect(removed).toContain(team2.id);

      // Verify memberships
      expect(await TeamModel.isUserInTeam(team1.id, ssoUser.id)).toBe(true);
      expect(await TeamModel.isUserInTeam(team2.id, ssoUser.id)).toBe(false);
    });

    test("should not remove manually added members", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id, { name: "Engineering" });

      await TeamModel.addExternalGroup(team.id, "engineering");

      // Add user manually (syncedFromSso = false)
      const manualUser = await makeUser({ email: "manual@test.com" });
      await TeamModel.addMember(
        team.id,
        manualUser.id,
        MEMBER_ROLE_NAME,
        false,
      );

      // Sync with empty groups - should NOT remove manually added member
      const { added, removed } = await TeamModel.syncUserTeams(
        manualUser.id,
        org.id,
        [],
      );

      expect(added).toHaveLength(0);
      expect(removed).toHaveLength(0);

      // Verify user is still a member
      expect(await TeamModel.isUserInTeam(team.id, manualUser.id)).toBe(true);
    });

    test("should handle multiple teams with the same group", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      // Both teams linked to the same external group
      await TeamModel.addExternalGroup(team1.id, "admins");
      await TeamModel.addExternalGroup(team2.id, "admins");

      const ssoUser = await makeUser({ email: "admin@test.com" });

      const { added } = await TeamModel.syncUserTeams(ssoUser.id, org.id, [
        "admins",
      ]);

      expect(added).toHaveLength(2);
      expect(added.sort()).toEqual([team1.id, team2.id].sort());
    });
  });
});
