import { describe, expect, test } from "@/test";
import TeamTokenModel, { isArchestraPrefixedToken } from "./team-token";

describe("TeamTokenModel", () => {
  describe("isArchestraPrefixedToken", () => {
    test("returns true for archestra_ prefixed tokens", () => {
      expect(isArchestraPrefixedToken("archestra_abc123")).toBe(true);
    });

    test("returns false for non-prefixed tokens", () => {
      expect(isArchestraPrefixedToken("abc123")).toBe(false);
    });

    test("returns false for empty string", () => {
      expect(isArchestraPrefixedToken("")).toBe(false);
    });
  });

  describe("create", () => {
    test("creates token with correct format", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const { token, value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Test Token",
        teamId: null,
      });

      expect(token.name).toBe("Test Token");
      expect(token.organizationId).toBe(org.id);
      expect(token.teamId).toBeNull();
      expect(value).toMatch(/^archestra_[a-f0-9]{32}$/);
      expect(token.tokenStart).toBe(value.substring(0, 14));
    });

    test("creates team-scoped token", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Dev Team" });

      const { token, value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Dev Team Token",
        teamId: team.id,
      });

      expect(token.teamId).toBe(team.id);
      expect(value.startsWith("archestra_")).toBe(true);
    });
  });

  describe("findById", () => {
    test("returns token by ID", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const { token } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Test Token",
        teamId: null,
      });

      const found = await TeamTokenModel.findById(token.id);
      expect(found?.id).toBe(token.id);
      expect(found?.name).toBe("Test Token");
    });

    test("returns null for non-existent ID", async () => {
      const found = await TeamTokenModel.findById(crypto.randomUUID());
      expect(found).toBeNull();
    });
  });

  describe("findAll", () => {
    test("returns all tokens", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Team A" });

      // Create org token and team token
      await TeamTokenModel.create({
        organizationId: org.id,
        name: "Organization Token",
        teamId: null,
      });

      await TeamTokenModel.create({
        organizationId: org.id,
        name: "Team A Token",
        teamId: team.id,
      });

      const tokens = await TeamTokenModel.findAll();
      expect(tokens).toHaveLength(2);
    });

    test("returns empty array when no tokens exist", async () => {
      const tokens = await TeamTokenModel.findAll();
      expect(tokens).toHaveLength(0);
    });
  });

  describe("findOrganizationToken", () => {
    test("returns org token (isOrganizationToken is true)", async ({
      makeOrganization,
    }) => {
      await makeOrganization();

      await TeamTokenModel.createOrganizationToken();

      const orgToken = await TeamTokenModel.findOrganizationToken();
      expect(orgToken?.isOrganizationToken).toBe(true);
      expect(orgToken?.teamId).toBeNull();
      expect(orgToken?.name).toBe("Organization Token");
    });

    test("returns null when no org token exists", async ({
      makeOrganization,
    }) => {
      await makeOrganization();
      const orgToken = await TeamTokenModel.findOrganizationToken();
      expect(orgToken).toBeNull();
    });
  });

  describe("findTeamToken", () => {
    test("returns token for team", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Dev Team" });

      await TeamTokenModel.create({
        organizationId: org.id,
        name: "Dev Team Token",
        teamId: team.id,
      });

      const teamToken = await TeamTokenModel.findTeamToken(team.id);
      expect(teamToken?.teamId).toBe(team.id);
    });
  });

  describe("rotate", () => {
    test("rotates token and returns new value", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const { token, value: originalValue } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Test Token",
        teamId: null,
      });

      const result = await TeamTokenModel.rotate(token.id);
      expect(result?.value).toBeDefined();
      expect(result?.value).not.toBe(originalValue);
      expect(result?.value.startsWith("archestra_")).toBe(true);

      const updated = await TeamTokenModel.findById(token.id);
      expect(updated?.tokenStart).toBe(result?.value.substring(0, 14));
    });

    test("returns null for non-existent token", async () => {
      const result = await TeamTokenModel.rotate(crypto.randomUUID());
      expect(result).toBeNull();
    });
  });

  describe("validateToken", () => {
    test("validates correct token", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const { token, value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Test Token",
        teamId: null,
      });

      const validated = await TeamTokenModel.validateToken(value);
      expect(validated?.id).toBe(token.id);
      expect(validated?.organizationId).toBe(org.id);
    });

    test("returns null for invalid token", async () => {
      const validated = await TeamTokenModel.validateToken(
        "archestra_invalidtoken12345",
      );
      expect(validated).toBeNull();
    });

    test("updates lastUsedAt on validation", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const { token, value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Test Token",
        teamId: null,
      });

      expect(token.lastUsedAt).toBeNull();

      await TeamTokenModel.validateToken(value);

      const updated = await TeamTokenModel.findById(token.id);
      expect(updated?.lastUsedAt).not.toBeNull();
    });
  });

  describe("createOrganizationToken", () => {
    test("creates org token with standard name", async ({
      makeOrganization,
    }) => {
      await makeOrganization();

      const { token } = await TeamTokenModel.createOrganizationToken();
      expect(token.name).toBe("Organization Token");
      expect(token.teamId).toBeNull();
    });
  });

  describe("createTeamToken", () => {
    test("creates team token with team name", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      await makeOrganization();
      const user = await makeUser();
      const org2 = await makeOrganization(); // Need org for team
      const team = await makeTeam(org2.id, user.id, { name: "Marketing" });

      const { token } = await TeamTokenModel.createTeamToken(
        team.id,
        "Marketing",
      );
      expect(token.name).toBe("Marketing Token");
      expect(token.teamId).toBe(team.id);
    });
  });

  describe("ensureOrganizationToken", () => {
    test("creates org token if not exists", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const token = await TeamTokenModel.ensureOrganizationToken();
      expect(token.organizationId).toBe(org.id);
      expect(token.teamId).toBeNull();
    });

    test("returns existing token if exists", async ({ makeOrganization }) => {
      await makeOrganization();

      const first = await TeamTokenModel.ensureOrganizationToken();
      const second = await TeamTokenModel.ensureOrganizationToken();

      expect(first.id).toBe(second.id);
    });
  });

  describe("getTokenValue", () => {
    test("returns full token value", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const { token, value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Test Token",
        teamId: null,
      });

      const retrievedValue = await TeamTokenModel.getTokenValue(token.id);
      expect(retrievedValue).toBe(value);
    });

    test("returns null for non-existent token", async () => {
      const value = await TeamTokenModel.getTokenValue(crypto.randomUUID());
      expect(value).toBeNull();
    });
  });

  describe("delete", () => {
    test("deletes token", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const { token } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Test Token",
        teamId: null,
      });

      const deleted = await TeamTokenModel.delete(token.id);
      expect(deleted).toBe(true);

      const found = await TeamTokenModel.findById(token.id);
      expect(found).toBeNull();
    });

    test("returns false for non-existent token", async () => {
      const deleted = await TeamTokenModel.delete(crypto.randomUUID());
      expect(deleted).toBe(false);
    });
  });
});
