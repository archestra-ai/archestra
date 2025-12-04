import { describe, expect, test } from "@/test";
import ProfileTokenModel, { isProfileToken } from "./profile-token";

describe("ProfileTokenModel", () => {
  describe("isProfileToken", () => {
    test("should return true for valid archestra_ prefixed tokens", async () => {
      expect(isProfileToken("archestra_abc123")).toBe(true);
      expect(isProfileToken("archestra_a1b2c3d4e5f6g7h8i9j0")).toBe(true);
    });

    test("should return false for non-archestra tokens", async () => {
      expect(isProfileToken("other_token")).toBe(false);
      expect(isProfileToken("uuid-like-token")).toBe(false);
      expect(isProfileToken("")).toBe(false);
    });
  });

  describe("create", () => {
    test("should create a token with archestra_ prefix", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();

      const { token, value } = await ProfileTokenModel.create({
        profileId: agent.id,
        name: "Test Token",
        isOrganizationToken: false,
      });

      expect(token.id).toBeDefined();
      expect(token.name).toBe("Test Token");
      expect(token.profileId).toBe(agent.id);
      expect(token.isOrganizationToken).toBe(false);
      expect(token.tokenStart).toMatch(/^archestra_/);
      expect(value).toMatch(/^archestra_/);
      expect(value.length).toBe(42); // archestra_ (10) + 32 hex chars
    });

    test("should create an organization-level token", async ({ makeAgent }) => {
      const agent = await makeAgent();

      const { token } = await ProfileTokenModel.create({
        profileId: agent.id,
        name: "Org Token",
        isOrganizationToken: true,
      });

      expect(token.isOrganizationToken).toBe(true);
    });

    test("should create token with team associations", async ({
      makeAgent,
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const agent = await makeAgent();
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      const { token } = await ProfileTokenModel.create(
        {
          profileId: agent.id,
          name: "Team Token",
          isOrganizationToken: false,
        },
        [team1.id, team2.id],
      );

      const teamIds = await ProfileTokenModel.getTeamIdsForToken(token.id);
      expect(teamIds).toHaveLength(2);
      expect(teamIds).toContain(team1.id);
      expect(teamIds).toContain(team2.id);
    });
  });

  describe("findById", () => {
    test("should find token by id", async ({ makeAgent }) => {
      const agent = await makeAgent();
      const { token } = await ProfileTokenModel.create({
        profileId: agent.id,
        name: "Test Token",
        isOrganizationToken: false,
      });

      const found = await ProfileTokenModel.findById(token.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(token.id);
      expect(found?.name).toBe("Test Token");
    });

    test("should return null for non-existent token", async () => {
      const found = await ProfileTokenModel.findById(crypto.randomUUID());
      expect(found).toBeNull();
    });
  });

  describe("findByProfileId", () => {
    test("should find all tokens for a profile", async ({ makeAgent }) => {
      const agent = await makeAgent();

      // Note: makeAgent now auto-creates a default token, so we expect 3 total
      await ProfileTokenModel.create({
        profileId: agent.id,
        name: "Token 1",
        isOrganizationToken: false,
      });
      await ProfileTokenModel.create({
        profileId: agent.id,
        name: "Token 2",
        isOrganizationToken: true,
      });

      const tokens = await ProfileTokenModel.findByProfileId(agent.id);

      // 1 default token + 2 created = 3 total
      expect(tokens).toHaveLength(3);
    });

    test("should return auto-created default token for new profile", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();
      const tokens = await ProfileTokenModel.findByProfileId(agent.id);
      // makeAgent auto-creates a default token
      expect(tokens).toHaveLength(1);
      expect(tokens[0].name).toBe("Default");
      expect(tokens[0].isOrganizationToken).toBe(true);
    });
  });

  describe("findByIdWithTeams", () => {
    test("should return token with team details", async ({
      makeAgent,
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const agent = await makeAgent();
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id, { name: "Marketing" });

      const { token } = await ProfileTokenModel.create(
        {
          profileId: agent.id,
          name: "Team Token",
          isOrganizationToken: false,
        },
        [team.id],
      );

      const tokenWithTeams = await ProfileTokenModel.findByIdWithTeams(
        token.id,
      );

      expect(tokenWithTeams).toBeDefined();
      expect(tokenWithTeams?.teams).toHaveLength(1);
      expect(tokenWithTeams?.teams[0].id).toBe(team.id);
      expect(tokenWithTeams?.teams[0].name).toBe("Marketing");
    });
  });

  describe("update", () => {
    test("should update token name", async ({ makeAgent }) => {
      const agent = await makeAgent();
      const { token } = await ProfileTokenModel.create({
        profileId: agent.id,
        name: "Original Name",
        isOrganizationToken: false,
      });

      const updated = await ProfileTokenModel.update(token.id, {
        name: "New Name",
      });

      expect(updated?.name).toBe("New Name");
    });

    test("should update isOrganizationToken", async ({ makeAgent }) => {
      const agent = await makeAgent();
      const { token } = await ProfileTokenModel.create({
        profileId: agent.id,
        name: "Token",
        isOrganizationToken: false,
      });

      const updated = await ProfileTokenModel.update(token.id, {
        isOrganizationToken: true,
      });

      expect(updated?.isOrganizationToken).toBe(true);
    });
  });

  describe("delete", () => {
    test("should delete token and its associations", async ({
      makeAgent,
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const agent = await makeAgent();
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      const { token } = await ProfileTokenModel.create(
        {
          profileId: agent.id,
          name: "To Delete",
          isOrganizationToken: false,
        },
        [team.id],
      );

      const deleted = await ProfileTokenModel.delete(token.id);
      expect(deleted).toBe(true);

      const found = await ProfileTokenModel.findById(token.id);
      expect(found).toBeNull();
    });

    test("should return false for non-existent token", async () => {
      const deleted = await ProfileTokenModel.delete(crypto.randomUUID());
      expect(deleted).toBe(false);
    });
  });

  describe("rotate", () => {
    test("should generate new token value", async ({ makeAgent }) => {
      const agent = await makeAgent();
      const { token, value: originalValue } = await ProfileTokenModel.create({
        profileId: agent.id,
        name: "To Rotate",
        isOrganizationToken: false,
      });

      const result = await ProfileTokenModel.rotate(token.id);

      expect(result).toBeDefined();
      expect(result?.value).not.toBe(originalValue);
      expect(result?.value).toMatch(/^archestra_/);

      // Verify token start was updated
      const updated = await ProfileTokenModel.findById(token.id);
      expect(updated?.tokenStart).not.toBe(token.tokenStart);
    });

    test("should return null for non-existent token", async () => {
      const result = await ProfileTokenModel.rotate(crypto.randomUUID());
      expect(result).toBeNull();
    });
  });

  describe("validateToken", () => {
    test("should validate correct token", async ({ makeAgent }) => {
      const agent = await makeAgent();
      const { token, value } = await ProfileTokenModel.create({
        profileId: agent.id,
        name: "Valid Token",
        isOrganizationToken: false,
      });

      const validated = await ProfileTokenModel.validateToken(agent.id, value);

      expect(validated).toBeDefined();
      expect(validated?.id).toBe(token.id);
    });

    test("should reject invalid token", async ({ makeAgent }) => {
      const agent = await makeAgent();
      await ProfileTokenModel.create({
        profileId: agent.id,
        name: "Token",
        isOrganizationToken: false,
      });

      const validated = await ProfileTokenModel.validateToken(
        agent.id,
        "archestra_invalid_token_value",
      );

      expect(validated).toBeNull();
    });

    test("should reject token from different profile", async ({
      makeAgent,
    }) => {
      const agent1 = await makeAgent();
      const agent2 = await makeAgent();

      const { value } = await ProfileTokenModel.create({
        profileId: agent1.id,
        name: "Agent 1 Token",
        isOrganizationToken: false,
      });

      const validated = await ProfileTokenModel.validateToken(agent2.id, value);

      expect(validated).toBeNull();
    });

    test("should update lastUsedAt on successful validation", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();
      const { token, value } = await ProfileTokenModel.create({
        profileId: agent.id,
        name: "Token",
        isOrganizationToken: false,
      });

      expect(token.lastUsedAt).toBeNull();

      await ProfileTokenModel.validateToken(agent.id, value);

      const updated = await ProfileTokenModel.findById(token.id);
      expect(updated?.lastUsedAt).toBeDefined();
      expect(updated?.lastUsedAt).not.toBeNull();
    });
  });

  describe("syncTeams", () => {
    test("should replace all team associations", async ({
      makeAgent,
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const agent = await makeAgent();
      const user = await makeUser();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });
      const team3 = await makeTeam(org.id, user.id, { name: "Team 3" });

      const { token } = await ProfileTokenModel.create(
        {
          profileId: agent.id,
          name: "Token",
          isOrganizationToken: false,
        },
        [team1.id, team2.id],
      );

      // Replace with team3 only
      await ProfileTokenModel.syncTeams(token.id, [team3.id]);

      const teamIds = await ProfileTokenModel.getTeamIdsForToken(token.id);
      expect(teamIds).toHaveLength(1);
      expect(teamIds).toContain(team3.id);
    });

    test("should allow clearing all teams", async ({
      makeAgent,
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const agent = await makeAgent();
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      const { token } = await ProfileTokenModel.create(
        {
          profileId: agent.id,
          name: "Token",
          isOrganizationToken: false,
        },
        [team.id],
      );

      await ProfileTokenModel.syncTeams(token.id, []);

      const teamIds = await ProfileTokenModel.getTeamIdsForToken(token.id);
      expect(teamIds).toHaveLength(0);
    });
  });

  describe("createDefaultToken", () => {
    test("should create organization token named Default", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();

      // makeAgent already creates a default token, so verify it exists
      const tokens = await ProfileTokenModel.findByProfileId(agent.id);
      const defaultToken = tokens.find((t) => t.name === "Default");

      expect(defaultToken).toBeDefined();
      expect(defaultToken?.isOrganizationToken).toBe(true);
    });
  });

  describe("createTeamToken", () => {
    test("should create team-scoped token with team name", async ({
      makeAgent,
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const agent = await makeAgent();
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id, { name: "Engineering" });

      const { token } = await ProfileTokenModel.createTeamToken(
        agent.id,
        team.id,
        "Engineering",
      );

      expect(token.name).toBe("Engineering Token");
      expect(token.isOrganizationToken).toBe(false);

      const teamIds = await ProfileTokenModel.getTeamIdsForToken(token.id);
      expect(teamIds).toContain(team.id);
    });
  });

  describe("hasTokens", () => {
    test("should return true when profile has tokens", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();
      // makeAgent auto-creates a default token, so profile already has tokens
      const hasTokens = await ProfileTokenModel.hasTokens(agent.id);
      expect(hasTokens).toBe(true);
    });

    test("should return true for auto-created default token", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();
      // Verify the auto-created token exists
      const hasTokens = await ProfileTokenModel.hasTokens(agent.id);
      expect(hasTokens).toBe(true);

      // Verify it's the default token
      const tokens = await ProfileTokenModel.findByProfileId(agent.id);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].name).toBe("Default");
    });
  });

  describe("findByTokenValue", () => {
    test("should find token by its value", async ({ makeAgent }) => {
      const agent = await makeAgent();
      const { token, value } = await ProfileTokenModel.create({
        profileId: agent.id,
        name: "Searchable Token",
        isOrganizationToken: false,
      });

      const found = await ProfileTokenModel.findByTokenValue(value);

      expect(found).toBeDefined();
      expect(found?.id).toBe(token.id);
    });

    test("should return null for non-existent token value", async () => {
      const found = await ProfileTokenModel.findByTokenValue(
        "archestra_nonexistent_value_12345678",
      );
      expect(found).toBeNull();
    });
  });
});
