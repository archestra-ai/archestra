import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { describe, expect, test } from "@/test";
import TeamModel from "./team";
import TeamVaultFolderModel from "./team-vault-folder";

describe("TeamVaultFolderModel", () => {
  describe("upsert", () => {
    test("should create a new vault folder mapping", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      const folder = await TeamVaultFolderModel.upsert(
        team.id,
        "secret/data/engineering",
      );

      expect(folder.id).toBeDefined();
      expect(folder.teamId).toBe(team.id);
      expect(folder.vaultPath).toBe("secret/data/engineering");
      expect(folder.createdAt).toBeDefined();
      expect(folder.updatedAt).toBeDefined();
    });

    test("should update existing vault folder mapping", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      const folder1 = await TeamVaultFolderModel.upsert(
        team.id,
        "secret/data/old-path",
      );

      const folder2 = await TeamVaultFolderModel.upsert(
        team.id,
        "secret/data/new-path",
      );

      // Should be the same record
      expect(folder2.id).toBe(folder1.id);
      expect(folder2.vaultPath).toBe("secret/data/new-path");
    });
  });

  describe("findByTeamId", () => {
    test("should find vault folder by team ID", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      await TeamVaultFolderModel.upsert(team.id, "secret/data/engineering");

      const folder = await TeamVaultFolderModel.findByTeamId(team.id);

      expect(folder).not.toBeNull();
      expect(folder?.teamId).toBe(team.id);
      expect(folder?.vaultPath).toBe("secret/data/engineering");
    });

    test("should return null for non-existent team", async () => {
      const folder = await TeamVaultFolderModel.findByTeamId(
        crypto.randomUUID(),
      );

      expect(folder).toBeNull();
    });
  });

  describe("findByTeamIds", () => {
    test("should find multiple vault folders by team IDs", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });
      const team3 = await makeTeam(org.id, user.id, { name: "Team 3" });

      await TeamVaultFolderModel.upsert(team1.id, "secret/data/team1");
      await TeamVaultFolderModel.upsert(team2.id, "secret/data/team2");
      // team3 has no vault folder

      const folders = await TeamVaultFolderModel.findByTeamIds([
        team1.id,
        team2.id,
        team3.id,
      ]);

      expect(folders).toHaveLength(2);
      expect(folders.map((f) => f.teamId).sort()).toEqual(
        [team1.id, team2.id].sort(),
      );
    });

    test("should return empty array for empty IDs array", async () => {
      const folders = await TeamVaultFolderModel.findByTeamIds([]);

      expect(folders).toEqual([]);
    });
  });

  describe("delete", () => {
    test("should delete vault folder mapping", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      await TeamVaultFolderModel.upsert(team.id, "secret/data/engineering");

      const deleted = await TeamVaultFolderModel.delete(team.id);
      expect(deleted).toBe(true);

      const folder = await TeamVaultFolderModel.findByTeamId(team.id);
      expect(folder).toBeNull();
    });

    test("should return false for non-existent team", async () => {
      const deleted = await TeamVaultFolderModel.delete(crypto.randomUUID());

      expect(deleted).toBe(false);
    });
  });

  describe("getAccessibleFolders", () => {
    test("should return all folders for org admin", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      await TeamVaultFolderModel.upsert(team1.id, "secret/data/team1");
      await TeamVaultFolderModel.upsert(team2.id, "secret/data/team2");

      const folders = await TeamVaultFolderModel.getAccessibleFolders(
        user.id,
        org.id,
        true, // isOrgAdmin
      );

      expect(folders).toHaveLength(2);
    });

    test("should return only folders for teams where user is admin", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const adminUser = await makeUser({ email: "admin@test.com" });
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, adminUser.id, {
        name: "Admin Team",
      });
      const team2 = await makeTeam(org.id, adminUser.id, {
        name: "Non-Admin Team",
      });

      await TeamVaultFolderModel.upsert(team1.id, "secret/data/team1");
      await TeamVaultFolderModel.upsert(team2.id, "secret/data/team2");

      // Add adminUser as admin to team1, member to team2
      const regularUser = await makeUser({ email: "regular@test.com" });
      await TeamModel.addMember(team1.id, regularUser.id, ADMIN_ROLE_NAME);
      await TeamModel.addMember(team2.id, regularUser.id, MEMBER_ROLE_NAME);

      const folders = await TeamVaultFolderModel.getAccessibleFolders(
        regularUser.id,
        org.id,
        false, // not org admin
      );

      expect(folders).toHaveLength(1);
      expect(folders[0].teamId).toBe(team1.id);
    });
  });

  describe("userHasAccess", () => {
    test("should return true for org admin", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      const hasAccess = await TeamVaultFolderModel.userHasAccess(
        user.id,
        team.id,
        true, // isOrgAdmin
      );

      expect(hasAccess).toBe(true);
    });

    test("should return true for team admin", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const creator = await makeUser({ email: "creator@test.com" });
      const org = await makeOrganization();
      const team = await makeTeam(org.id, creator.id);

      const teamAdmin = await makeUser({ email: "teamadmin@test.com" });
      await TeamModel.addMember(team.id, teamAdmin.id, ADMIN_ROLE_NAME);

      const hasAccess = await TeamVaultFolderModel.userHasAccess(
        teamAdmin.id,
        team.id,
        false, // not org admin
      );

      expect(hasAccess).toBe(true);
    });

    test("should return false for regular team member", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const creator = await makeUser({ email: "creator@test.com" });
      const org = await makeOrganization();
      const team = await makeTeam(org.id, creator.id);

      const regularMember = await makeUser({ email: "member@test.com" });
      await TeamModel.addMember(team.id, regularMember.id, MEMBER_ROLE_NAME);

      const hasAccess = await TeamVaultFolderModel.userHasAccess(
        regularMember.id,
        team.id,
        false, // not org admin
      );

      expect(hasAccess).toBe(false);
    });

    test("should return false for non-member", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const creator = await makeUser({ email: "creator@test.com" });
      const org = await makeOrganization();
      const team = await makeTeam(org.id, creator.id);

      const nonMember = await makeUser({ email: "nonmember@test.com" });

      const hasAccess = await TeamVaultFolderModel.userHasAccess(
        nonMember.id,
        team.id,
        false, // not org admin
      );

      expect(hasAccess).toBe(false);
    });
  });

  describe("isVaultPathAccessible", () => {
    test("should return true if path starts with accessible folder path", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      await TeamModel.addMember(team.id, user.id, ADMIN_ROLE_NAME);
      await TeamVaultFolderModel.upsert(team.id, "secret/data/engineering");

      const isAccessible = await TeamVaultFolderModel.isVaultPathAccessible(
        user.id,
        org.id,
        "secret/data/engineering/api-keys",
        false,
      );

      expect(isAccessible).toBe(true);
    });

    test("should return false if path does not match any accessible folder", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      await TeamModel.addMember(team.id, user.id, ADMIN_ROLE_NAME);
      await TeamVaultFolderModel.upsert(team.id, "secret/data/engineering");

      const isAccessible = await TeamVaultFolderModel.isVaultPathAccessible(
        user.id,
        org.id,
        "secret/data/finance/budgets",
        false,
      );

      expect(isAccessible).toBe(false);
    });

    test("should return true for org admin even if no team folders match", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      await TeamVaultFolderModel.upsert(team.id, "secret/data/engineering");

      const isAccessible = await TeamVaultFolderModel.isVaultPathAccessible(
        user.id,
        org.id,
        "secret/data/engineering/api-keys",
        true, // org admin
      );

      expect(isAccessible).toBe(true);
    });
  });
});
