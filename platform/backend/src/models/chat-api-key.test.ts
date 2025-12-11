import { describe, expect, test } from "@/test";
import ChatApiKeyModel from "./chat-api-key";

describe("ChatApiKeyModel", () => {
  describe("create", () => {
    test("can create a chat API key", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Test Anthropic Key",
        provider: "anthropic",
      });

      expect(apiKey).toBeDefined();
      expect(apiKey.id).toBeDefined();
      expect(apiKey.organizationId).toBe(org.id);
      expect(apiKey.name).toBe("Test Anthropic Key");
      expect(apiKey.provider).toBe("anthropic");
      expect(apiKey.isOrganizationDefault).toBe(false);
      expect(apiKey.secretId).toBeNull();
      expect(apiKey.createdAt).toBeDefined();
      expect(apiKey.updatedAt).toBeDefined();
    });

    test("can create a chat API key with secret", async ({
      makeOrganization,
      makeSecret,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret({
        name: "chat-api-key",
        secret: { apiKey: "sk-test-key" },
      });

      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Test Key with Secret",
        provider: "anthropic",
        secretId: secret.id,
      });

      expect(apiKey.secretId).toBe(secret.id);
    });

    test("can create a chat API key as organization default", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Default Key",
        provider: "anthropic",
        isOrganizationDefault: true,
      });

      expect(apiKey.isOrganizationDefault).toBe(true);
    });
  });

  describe("findById", () => {
    test("can find a chat API key by ID", async ({ makeOrganization }) => {
      const org = await makeOrganization();
      const created = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Test Key",
        provider: "anthropic",
      });

      const found = await ChatApiKeyModel.findById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.name).toBe("Test Key");
    });

    test("returns undefined for non-existent ID", async () => {
      const found = await ChatApiKeyModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(found).toBeUndefined();
    });
  });

  describe("findByOrganizationId", () => {
    test("can find all chat API keys for an organization", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Key 1",
        provider: "anthropic",
      });
      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Key 2",
        provider: "openai",
      });

      const keys = await ChatApiKeyModel.findByOrganizationId(org.id);

      expect(keys).toHaveLength(2);
      expect(keys.map((k) => k.name)).toContain("Key 1");
      expect(keys.map((k) => k.name)).toContain("Key 2");
    });

    test("returns empty array for organization with no keys", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const keys = await ChatApiKeyModel.findByOrganizationId(org.id);

      expect(keys).toHaveLength(0);
    });

    test("isolates keys by organization", async ({ makeOrganization }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      await ChatApiKeyModel.create({
        organizationId: org1.id,
        name: "Org1 Key",
        provider: "anthropic",
      });
      await ChatApiKeyModel.create({
        organizationId: org2.id,
        name: "Org2 Key",
        provider: "anthropic",
      });

      const org1Keys = await ChatApiKeyModel.findByOrganizationId(org1.id);
      const org2Keys = await ChatApiKeyModel.findByOrganizationId(org2.id);

      expect(org1Keys).toHaveLength(1);
      expect(org1Keys[0].name).toBe("Org1 Key");
      expect(org2Keys).toHaveLength(1);
      expect(org2Keys[0].name).toBe("Org2 Key");
    });
  });

  describe("findOrganizationDefault", () => {
    test("can find the organization default for a provider", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Non-default Key",
        provider: "anthropic",
      });
      const defaultKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Default Key",
        provider: "anthropic",
        isOrganizationDefault: true,
      });

      const found = await ChatApiKeyModel.findOrganizationDefault(
        org.id,
        "anthropic",
      );

      expect(found).toBeDefined();
      expect(found?.id).toBe(defaultKey.id);
      expect(found?.isOrganizationDefault).toBe(true);
    });

    test("returns null when no default exists", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Non-default Key",
        provider: "anthropic",
      });

      const found = await ChatApiKeyModel.findOrganizationDefault(
        org.id,
        "anthropic",
      );

      expect(found).toBeNull();
    });

    test("finds correct default per provider", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const anthropicDefault = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Anthropic Default",
        provider: "anthropic",
        isOrganizationDefault: true,
      });
      const openaiDefault = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "OpenAI Default",
        provider: "openai",
        isOrganizationDefault: true,
      });

      const foundAnthropic = await ChatApiKeyModel.findOrganizationDefault(
        org.id,
        "anthropic",
      );
      const foundOpenai = await ChatApiKeyModel.findOrganizationDefault(
        org.id,
        "openai",
      );

      expect(foundAnthropic?.id).toBe(anthropicDefault.id);
      expect(foundOpenai?.id).toBe(openaiDefault.id);
    });
  });

  describe("update", () => {
    test("can update a chat API key", async ({ makeOrganization }) => {
      const org = await makeOrganization();
      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Original Name",
        provider: "anthropic",
      });

      const updated = await ChatApiKeyModel.update(apiKey.id, {
        name: "Updated Name",
      });

      expect(updated).toBeDefined();
      expect(updated?.name).toBe("Updated Name");
      expect(updated?.provider).toBe("anthropic");
    });

    test("returns undefined when updating non-existent key", async () => {
      const result = await ChatApiKeyModel.update(
        "00000000-0000-0000-0000-000000000000",
        { name: "New Name" },
      );

      expect(result).toBeUndefined();
    });
  });

  describe("delete", () => {
    test("can delete a chat API key", async ({ makeOrganization }) => {
      const org = await makeOrganization();
      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "To Delete",
        provider: "anthropic",
      });

      const deleted = await ChatApiKeyModel.delete(apiKey.id);
      const found = await ChatApiKeyModel.findById(apiKey.id);

      expect(deleted).toBe(true);
      expect(found).toBeUndefined();
    });

    test("returns false when deleting non-existent key", async () => {
      const deleted = await ChatApiKeyModel.delete(
        "00000000-0000-0000-0000-000000000000",
      );

      expect(deleted).toBe(false);
    });
  });

  describe("setAsOrganizationDefault", () => {
    test("can set a key as organization default", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Test Key",
        provider: "anthropic",
      });

      const updated = await ChatApiKeyModel.setAsOrganizationDefault(apiKey.id);

      expect(updated?.isOrganizationDefault).toBe(true);
    });

    test("unsets previous default when setting new default", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const key1 = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Key 1",
        provider: "anthropic",
        isOrganizationDefault: true,
      });
      const key2 = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Key 2",
        provider: "anthropic",
      });

      await ChatApiKeyModel.setAsOrganizationDefault(key2.id);

      const updatedKey1 = await ChatApiKeyModel.findById(key1.id);
      const updatedKey2 = await ChatApiKeyModel.findById(key2.id);

      expect(updatedKey1?.isOrganizationDefault).toBe(false);
      expect(updatedKey2?.isOrganizationDefault).toBe(true);
    });

    test("does not affect other providers when setting default", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const anthropicKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Anthropic Key",
        provider: "anthropic",
        isOrganizationDefault: true,
      });
      const openaiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "OpenAI Key",
        provider: "openai",
      });

      await ChatApiKeyModel.setAsOrganizationDefault(openaiKey.id);

      const updatedAnthropicKey = await ChatApiKeyModel.findById(
        anthropicKey.id,
      );
      const updatedOpenaiKey = await ChatApiKeyModel.findById(openaiKey.id);

      expect(updatedAnthropicKey?.isOrganizationDefault).toBe(true);
      expect(updatedOpenaiKey?.isOrganizationDefault).toBe(true);
    });

    test("returns null for non-existent key", async () => {
      const result = await ChatApiKeyModel.setAsOrganizationDefault(
        "00000000-0000-0000-0000-000000000000",
      );

      expect(result).toBeNull();
    });

    test("database constraint prevents multiple defaults per provider via direct insert", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      // Create first default key
      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Default Key 1",
        provider: "anthropic",
        isOrganizationDefault: true,
      });

      // Trying to create second default for same provider should fail with unique constraint violation
      await expect(
        ChatApiKeyModel.create({
          organizationId: org.id,
          name: "Default Key 2",
          provider: "anthropic",
          isOrganizationDefault: true,
        }),
      ).rejects.toThrow();
    });

    test("database constraint allows defaults for different providers", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      // Create default for anthropic
      const anthropicDefault = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Anthropic Default",
        provider: "anthropic",
        isOrganizationDefault: true,
      });

      // Create default for openai - should succeed (different provider)
      const openaiDefault = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "OpenAI Default",
        provider: "openai",
        isOrganizationDefault: true,
      });

      expect(anthropicDefault.isOrganizationDefault).toBe(true);
      expect(openaiDefault.isOrganizationDefault).toBe(true);

      // Verify both are returned as defaults for their respective providers
      const foundAnthropic = await ChatApiKeyModel.findOrganizationDefault(
        org.id,
        "anthropic",
      );
      const foundOpenai = await ChatApiKeyModel.findOrganizationDefault(
        org.id,
        "openai",
      );

      expect(foundAnthropic?.id).toBe(anthropicDefault.id);
      expect(foundOpenai?.id).toBe(openaiDefault.id);
    });
  });

  describe("profile assignments", () => {
    test("can assign an API key to a profile", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent();
      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Test Key",
        provider: "anthropic",
      });

      const assignment = await ChatApiKeyModel.assignToProfile({
        chatApiKeyId: apiKey.id,
        agentId: agent.id,
      });

      expect(assignment).toBeDefined();
      expect(assignment.chatApiKeyId).toBe(apiKey.id);
      expect(assignment.agentId).toBe(agent.id);
    });

    test("replaces existing same-provider key when assigning new one to profile", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent();

      // Create two anthropic keys
      const anthropicKey1 = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Anthropic Key 1",
        provider: "anthropic",
      });
      const anthropicKey2 = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Anthropic Key 2",
        provider: "anthropic",
      });

      // Assign first anthropic key
      await ChatApiKeyModel.assignToProfile({
        chatApiKeyId: anthropicKey1.id,
        agentId: agent.id,
      });

      // Assign second anthropic key - should replace first
      await ChatApiKeyModel.assignToProfile({
        chatApiKeyId: anthropicKey2.id,
        agentId: agent.id,
      });

      // Profile should only have one anthropic key (the second one)
      const profileKeys = await ChatApiKeyModel.getProfileApiKeys(agent.id);
      const anthropicKeys = profileKeys.filter(
        (k) => k.provider === "anthropic",
      );

      expect(anthropicKeys).toHaveLength(1);
      expect(anthropicKeys[0].id).toBe(anthropicKey2.id);
    });

    test("allows different provider keys on same profile", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent();

      const anthropicKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Anthropic Key",
        provider: "anthropic",
      });
      const openaiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "OpenAI Key",
        provider: "openai",
      });

      await ChatApiKeyModel.assignToProfile({
        chatApiKeyId: anthropicKey.id,
        agentId: agent.id,
      });
      await ChatApiKeyModel.assignToProfile({
        chatApiKeyId: openaiKey.id,
        agentId: agent.id,
      });

      // Profile should have both keys (different providers)
      const profileKeys = await ChatApiKeyModel.getProfileApiKeys(agent.id);
      expect(profileKeys).toHaveLength(2);
      expect(profileKeys.map((k) => k.provider)).toContain("anthropic");
      expect(profileKeys.map((k) => k.provider)).toContain("openai");
    });

    test("can unassign an API key from a profile", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent();
      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Test Key",
        provider: "anthropic",
      });

      await ChatApiKeyModel.assignToProfile({
        chatApiKeyId: apiKey.id,
        agentId: agent.id,
      });

      const unassigned = await ChatApiKeyModel.unassignFromProfile(
        apiKey.id,
        agent.id,
      );

      expect(unassigned).toBe(true);

      const profiles = await ChatApiKeyModel.getAssignedProfiles(apiKey.id);
      expect(profiles).toHaveLength(0);
    });

    test("can get all assigned profiles for an API key", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });
      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Test Key",
        provider: "anthropic",
      });

      await ChatApiKeyModel.assignToProfile({
        chatApiKeyId: apiKey.id,
        agentId: agent1.id,
      });
      await ChatApiKeyModel.assignToProfile({
        chatApiKeyId: apiKey.id,
        agentId: agent2.id,
      });

      const profiles = await ChatApiKeyModel.getAssignedProfiles(apiKey.id);

      expect(profiles).toHaveLength(2);
      expect(profiles.map((p) => p.name)).toContain("Agent 1");
      expect(profiles.map((p) => p.name)).toContain("Agent 2");
    });

    test("can bulk assign profiles to an API key", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent();
      const agent2 = await makeAgent();
      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Test Key",
        provider: "anthropic",
      });

      await ChatApiKeyModel.bulkAssignProfiles(apiKey.id, [
        agent1.id,
        agent2.id,
      ]);

      const profiles = await ChatApiKeyModel.getAssignedProfiles(apiKey.id);
      expect(profiles).toHaveLength(2);
    });

    test("can replace profile assignments", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });
      const agent3 = await makeAgent({ name: "Agent 3" });
      const apiKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Test Key",
        provider: "anthropic",
      });

      // Initial assignment
      await ChatApiKeyModel.bulkAssignProfiles(apiKey.id, [
        agent1.id,
        agent2.id,
      ]);

      // Replace with different profiles
      await ChatApiKeyModel.replaceProfileAssignments(apiKey.id, [
        agent2.id,
        agent3.id,
      ]);

      const profiles = await ChatApiKeyModel.getAssignedProfiles(apiKey.id);
      expect(profiles).toHaveLength(2);
      expect(profiles.map((p) => p.name)).not.toContain("Agent 1");
      expect(profiles.map((p) => p.name)).toContain("Agent 2");
      expect(profiles.map((p) => p.name)).toContain("Agent 3");
    });
  });

  describe("getProfileApiKey", () => {
    test("returns profile-specific key when assigned", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent();

      const defaultKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Default Key",
        provider: "anthropic",
        isOrganizationDefault: true,
      });
      const profileKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Profile Key",
        provider: "anthropic",
      });

      await ChatApiKeyModel.assignToProfile({
        chatApiKeyId: profileKey.id,
        agentId: agent.id,
      });

      const found = await ChatApiKeyModel.getProfileApiKey(
        agent.id,
        "anthropic",
        org.id,
      );

      expect(found?.id).toBe(profileKey.id);
      expect(found?.id).not.toBe(defaultKey.id);
    });

    test("falls back to organization default when no profile key", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent();

      const defaultKey = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Default Key",
        provider: "anthropic",
        isOrganizationDefault: true,
      });

      const found = await ChatApiKeyModel.getProfileApiKey(
        agent.id,
        "anthropic",
        org.id,
      );

      expect(found?.id).toBe(defaultKey.id);
    });

    test("returns null when no key available", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent();

      const found = await ChatApiKeyModel.getProfileApiKey(
        agent.id,
        "anthropic",
        org.id,
      );

      expect(found).toBeNull();
    });
  });

  describe("findByOrganizationIdWithProfiles", () => {
    test("returns API keys with their assigned profiles", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });

      const key1 = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Key 1",
        provider: "anthropic",
      });
      const key2 = await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Key 2",
        provider: "openai",
      });

      await ChatApiKeyModel.assignToProfile({
        chatApiKeyId: key1.id,
        agentId: agent1.id,
      });
      await ChatApiKeyModel.assignToProfile({
        chatApiKeyId: key1.id,
        agentId: agent2.id,
      });

      const keysWithProfiles =
        await ChatApiKeyModel.findByOrganizationIdWithProfiles(org.id);

      expect(keysWithProfiles).toHaveLength(2);

      const foundKey1 = keysWithProfiles.find((k) => k.id === key1.id);
      const foundKey2 = keysWithProfiles.find((k) => k.id === key2.id);

      expect(foundKey1?.profiles).toHaveLength(2);
      expect(foundKey2?.profiles).toHaveLength(0);
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
    }) => {
      const org = await makeOrganization();

      await ChatApiKeyModel.create({
        organizationId: org.id,
        name: "Anthropic Key",
        provider: "anthropic",
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
