import { describe, expect, test } from "@/test";
import ChatApiKeyModel from "./chat-api-key";

describe("ChatApiKeyModel", () => {
  describe("create", () => {
    test("can create a personal chat API key", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "My Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      expect(apiKey).toBeDefined();
      expect(apiKey.id).toBeDefined();
      expect(apiKey.organizationId).toBe(org.id);
      expect(apiKey.name).toBe("My Personal Key");
      expect(apiKey.provider).toBe("anthropic");
      expect(apiKey.scope).toBe("personal");
      expect(apiKey.userId).toBe(user.id);
      expect(apiKey.teamId).toBeNull();
    });

    test("can create a team chat API key", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Test Team" });

      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Team Key",
        provider: "anthropic",
        scope: "team",
        teamId: team.id,
      });

      expect(apiKey.scope).toBe("team");
      expect(apiKey.teamId).toBe(team.id);
      expect(apiKey.userId).toBeNull();
    });

    test("can create an org-wide chat API key", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Org Wide Key",
        provider: "anthropic",
        scope: "org_wide",
      });

      expect(apiKey.scope).toBe("org_wide");
      expect(apiKey.userId).toBeNull();
      expect(apiKey.teamId).toBeNull();
    });

    test("enforces unique constraint for personal keys per user per provider", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Personal Key 1",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      await expect(
        ChatApiKeyModel.create({
          organizationId: org.id,
          name: "Personal Key 2",
          provider: "anthropic",
          scope: "personal",
          userId: user.id,
        }),
      ).rejects.toThrow();
    });

    test("allows personal keys for different providers", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const anthropicKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Anthropic Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      const openaiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "OpenAI Key",
        provider: "openai",
        scope: "personal",
        userId: user.id,
      });

      expect(anthropicKey.provider).toBe("anthropic");
      expect(openaiKey.provider).toBe("openai");
    });
  });

  describe("findById", () => {
    test("can find a chat API key by ID", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const created = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Test Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      const found = await ChatApiKeyModel.findById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.name).toBe("Test Key");
    });

    test("returns null for non-existent ID", async () => {
      const found = await ChatApiKeyModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(found).toBeNull();
    });
  });

  describe("findByOrganizationId", () => {
    test("can find all chat API keys for an organization", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Key 1",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });
      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Key 2",
        provider: "openai",
        scope: "org_wide",
      });

      const keys = await ChatApiKeyModel.findByOrganizationId(org.id);

      expect(keys).toHaveLength(2);
      expect(keys.map((k) => k.name)).toContain("Key 1");
      expect(keys.map((k) => k.name)).toContain("Key 2");
    });
  });

  describe("findByScope", () => {
    test("can find org-wide key by scope", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const orgWideKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Org Wide Key",
        provider: "anthropic",
        scope: "org_wide",
      });

      const found = await ChatApiKeyModel.findByScope(
        org.id,
        "anthropic",
        "org_wide",
      );

      expect(found).toBeDefined();
      expect(found?.id).toBe(orgWideKey.id);
    });

    test("returns null when no key exists for scope", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const found = await ChatApiKeyModel.findByScope(
        org.id,
        "anthropic",
        "org_wide",
      );

      expect(found).toBeNull();
    });
  });

  describe("update", () => {
    test("can update a chat API key", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Original Name",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      const updated = await ChatApiKeyModel.update(apiKey.id, {
        name: "Updated Name",
      });

      expect(updated).toBeDefined();
      expect(updated?.name).toBe("Updated Name");
    });
  });

  describe("delete", () => {
    test("can delete a chat API key", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "To Delete",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      const deleted = await ChatApiKeyModel.delete(apiKey.id);
      const found = await ChatApiKeyModel.findById(apiKey.id);

      expect(deleted).toBe(true);
      expect(found).toBeNull();
    });
  });

  describe("getVisibleKeys", () => {
    test("user sees their own personal keys", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user1 = await makeUser({ email: "user1@test.com" });
      const user2 = await makeUser({ email: "user2@test.com" });

      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "User1 Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: user1.id,
      });
      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "User2 Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: user2.id,
      });

      const visibleToUser1 = await ChatApiKeyModel.getVisibleKeys(
        org.id,
        user1.id,
        [],
        false,
      );

      expect(visibleToUser1).toHaveLength(1);
      expect(visibleToUser1[0].name).toBe("User1 Personal Key");
    });

    test("user sees team keys for their teams", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Test Team" });

      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Team Key",
        provider: "anthropic",
        scope: "team",
        teamId: team.id,
      });

      const visible = await ChatApiKeyModel.getVisibleKeys(
        org.id,
        user.id,
        [team.id],
        false,
      );

      expect(visible).toHaveLength(1);
      expect(visible[0].name).toBe("Team Key");
    });

    test("user sees org-wide keys", async ({ makeOrganization, makeUser }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Org Wide Key",
        provider: "anthropic",
        scope: "org_wide",
      });

      const visible = await ChatApiKeyModel.getVisibleKeys(
        org.id,
        user.id,
        [],
        false,
      );

      expect(visible).toHaveLength(1);
      expect(visible[0].name).toBe("Org Wide Key");
    });

    test("admin sees all keys except other users personal keys", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const admin = await makeUser({ email: "admin@test.com" });
      const user = await makeUser({ email: "user@test.com" });

      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Admin Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: admin.id,
      });
      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "User Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });
      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Org Wide Key",
        provider: "openai",
        scope: "org_wide",
      });

      const visible = await ChatApiKeyModel.getVisibleKeys(
        org.id,
        admin.id,
        [],
        true, // isProfileAdmin
      );

      // Admin sees own personal key, all team keys, all org-wide keys, but not other users' personal keys
      expect(visible).toHaveLength(2);
      expect(visible.map((k) => k.name)).toContain("Admin Personal Key");
      expect(visible.map((k) => k.name)).toContain("Org Wide Key");
      expect(visible.map((k) => k.name)).not.toContain("User Personal Key");
    });
  });

  describe("resolveApiKey", () => {
    test("returns personal key first", async ({
      makeOrganization,
      makeUser,
      makeSecret,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const secret1 = await makeSecret();
      const secret2 = await makeSecret();

      const personalKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
        secretId: secret1.id,
      });
      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Org Wide Key",
        provider: "anthropic",
        scope: "org_wide",
        secretId: secret2.id,
      });

      const resolved = await ChatApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
        provider: "anthropic",
        conversationId: null,
      });

      expect(resolved?.id).toBe(personalKey.id);
    });

    test("falls back to team key when no personal key", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeSecret,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Test Team" });
      const secret1 = await makeSecret();
      const secret2 = await makeSecret();

      const teamKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Team Key",
        provider: "anthropic",
        scope: "team",
        teamId: team.id,
        secretId: secret1.id,
      });
      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Org Wide Key",
        provider: "anthropic",
        scope: "org_wide",
        secretId: secret2.id,
      });

      const resolved = await ChatApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [team.id],
        provider: "anthropic",
        conversationId: null,
      });

      expect(resolved?.id).toBe(teamKey.id);
    });

    test("falls back to org-wide key when no personal or team key", async ({
      makeOrganization,
      makeUser,
      makeSecret,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const secret = await makeSecret();

      const orgWideKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Org Wide Key",
        provider: "anthropic",
        scope: "org_wide",
        secretId: secret.id,
      });

      const resolved = await ChatApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
        provider: "anthropic",
        conversationId: null,
      });

      expect(resolved?.id).toBe(orgWideKey.id);
    });

    test("returns conversation key when specified", async ({
      makeOrganization,
      makeUser,
      makeSecret,
      makeAgent,
      makeConversation,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const secret1 = await makeSecret();
      const secret2 = await makeSecret();
      const agent = await makeAgent({ name: "Test Agent", teams: [] });

      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
        secretId: secret1.id,
      });
      const conversationKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Org Wide Key",
        provider: "anthropic",
        scope: "org_wide",
        secretId: secret2.id,
      });

      // Create a conversation with the org-wide key as its chatApiKeyId
      const conversation = await makeConversation(agent.id, {
        userId: user.id,
        organizationId: org.id,
        chatApiKeyId: conversationKey.id,
      });

      const resolved = await ChatApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
        provider: "anthropic",
        conversationId: conversation.id,
      });

      expect(resolved?.id).toBe(conversationKey.id);
    });

    test("returns null when no keys available", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const resolved = await ChatApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
        provider: "anthropic",
        conversationId: null,
      });

      expect(resolved).toBeNull();
    });
  });

  describe("hasAnyApiKey", () => {
    test("returns true when organization has API keys", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Test Key",
        provider: "anthropic",
        scope: "org_wide",
      });

      const hasKeys = await ChatApiKeyModel.hasAnyApiKey(org.id);

      expect(hasKeys).toBe(true);
    });

    test("returns false when organization has no API keys", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const hasKeys = await ChatApiKeyModel.hasAnyApiKey(org.id);

      expect(hasKeys).toBe(false);
    });
  });

  describe("hasConfiguredApiKey", () => {
    test("returns true when configured API key exists for provider", async ({
      makeOrganization,
      makeSecret,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();

      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Anthropic Key",
        provider: "anthropic",
        scope: "org_wide",
        secretId: secret.id,
      });

      const hasAnthropic = await ChatApiKeyModel.hasConfiguredApiKey(
        org.id,
        "anthropic",
      );
      const hasOpenai = await ChatApiKeyModel.hasConfiguredApiKey(
        org.id,
        "openai",
      );

      expect(hasAnthropic).toBe(true);
      expect(hasOpenai).toBe(false);
    });
  });
});
