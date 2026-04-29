import {
  ARCHESTRA_TOKEN_PREFIX,
  LEGACY_ARCHESTRA_TOKEN_PREFIXES,
} from "@shared";
import { describe } from "vitest";
import { expect, test } from "@/test";
import VirtualApiKeyModel from "./virtual-api-key";

describe("VirtualApiKeyModel", () => {
  // =========================================================================
  // create
  // =========================================================================

  test("create: creates a virtual key and returns the token value", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-real-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    const { virtualKey, value } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Test Virtual Key",
    });

    expect(virtualKey.id).toBeDefined();
    expect(virtualKey.chatApiKeyId).toBe(chatApiKey.id);
    expect(virtualKey.name).toBe("Test Virtual Key");
    expect(virtualKey.expiresAt).toBeNull();
    expect(value).toMatch(
      new RegExp(`^${ARCHESTRA_TOKEN_PREFIX}[a-f0-9]{64}$`),
    );
    expect(virtualKey.tokenStart).toBe(value.substring(0, 14));
  });

  test("create: stores expiresAt when provided", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-real-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    const futureDate = new Date(Date.now() + 86400_000);
    const { virtualKey } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Expiring Key",
      expiresAt: futureDate,
    });

    expect(virtualKey.expiresAt).toBeInstanceOf(Date);
    expect(virtualKey.expiresAt?.getTime()).toBe(futureDate.getTime());
  });

  test("create: stores scope, author, and team assignments", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const secret = await makeSecret({ secret: { apiKey: "sk-real-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    const { virtualKey, teams, authorName } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Team Virtual Key",
      scope: "team",
      authorId: user.id,
      teamIds: [team.id],
    });

    expect(virtualKey.scope).toBe("team");
    expect(virtualKey.authorId).toBe(user.id);
    expect(teams).toEqual([{ id: team.id, name: team.name }]);
    expect(authorName).toBe(user.name);
    expect(
      await VirtualApiKeyModel.getTeamIdsForVirtualApiKey(virtualKey.id),
    ).toEqual([team.id]);
  });

  // =========================================================================
  // findByChatApiKeyId
  // =========================================================================

  test("findByChatApiKeyId: returns all virtual keys for a chat API key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Key A",
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Key B",
    });

    const keys = await VirtualApiKeyModel.findByChatApiKeyId(chatApiKey.id);
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.name)).toContain("Key A");
    expect(keys.map((k) => k.name)).toContain("Key B");
  });

  test("findByChatApiKeyId: returns empty array for unknown id", async () => {
    const keys = await VirtualApiKeyModel.findByChatApiKeyId(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(keys).toHaveLength(0);
  });

  test("findByChatApiKeyId: respects organization boundary for access-controlled lookups", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeLlmProviderApiKey(orgB.id, secret.id);

    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Other Org Key",
      scope: "org",
    });

    const keys = await VirtualApiKeyModel.findByChatApiKeyId({
      chatApiKeyId: chatApiKey.id,
      organizationId: orgA.id,
      userId: user.id,
      userTeamIds: [],
      isAdmin: true,
    });

    expect(keys).toEqual([]);
  });

  // =========================================================================
  // findById
  // =========================================================================

  test("findById: returns the virtual key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    const { virtualKey } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Find Me",
    });

    const found = await VirtualApiKeyModel.findById(virtualKey.id);
    expect(found).not.toBeNull();
    expect(found?.name).toBe("Find Me");
  });

  test("findById: returns null for unknown id", async () => {
    const found = await VirtualApiKeyModel.findById(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(found).toBeNull();
  });

  // =========================================================================
  // delete
  // =========================================================================

  test("delete: removes a virtual key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    const { virtualKey } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Delete Me",
    });

    const deleted = await VirtualApiKeyModel.delete(virtualKey.id);
    expect(deleted).toBe(true);

    const found = await VirtualApiKeyModel.findById(virtualKey.id);
    expect(found).toBeNull();
  });

  test("delete: returns false for unknown id", async () => {
    const deleted = await VirtualApiKeyModel.delete(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(deleted).toBe(false);
  });

  // =========================================================================
  // countByChatApiKeyId
  // =========================================================================

  test("countByChatApiKeyId: returns correct count", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    expect(await VirtualApiKeyModel.countByChatApiKeyId(chatApiKey.id)).toBe(0);

    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Key 1",
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Key 2",
    });

    expect(await VirtualApiKeyModel.countByChatApiKeyId(chatApiKey.id)).toBe(2);
  });

  // =========================================================================
  // validateToken
  // =========================================================================

  test("validateToken: validates a correct token and returns key + chat API key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    const { value } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Validate Me",
    });

    const result = await VirtualApiKeyModel.validateToken(value);
    expect(result).not.toBeNull();
    expect(result?.virtualKey.name).toBe("Validate Me");
    expect(result?.chatApiKey).not.toBeNull();
    if (!result?.chatApiKey) {
      throw new Error("Expected parent chat API key");
    }
    expect(result.chatApiKey.id).toBe(chatApiKey.id);
  });

  test("validateToken: returns null for invalid token", async () => {
    const result = await VirtualApiKeyModel.validateToken(
      `${LEGACY_ARCHESTRA_TOKEN_PREFIXES[0]}0000000000000000000000000000`,
    );
    expect(result).toBeNull();
  });

  test("validateToken: returns null for non-platform token", async () => {
    const result = await VirtualApiKeyModel.validateToken("sk-some-random-key");
    expect(result).toBeNull();
  });

  // =========================================================================
  // findAllByOrganization
  // =========================================================================

  test("findAllByOrganization: returns virtual keys with parent API key info", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      name: "Parent Key",
      provider: "anthropic",
    });

    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Virtual A",
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Virtual B",
    });

    const result = await VirtualApiKeyModel.findAllByOrganization({
      organizationId: org.id,
      pagination: { limit: 20, offset: 0 },
    });
    expect(result.data).toHaveLength(2);
    expect(result.data[0].parentKeyName).toBe("Parent Key");
    expect(result.data[0].parentKeyProvider).toBe("anthropic");
    expect(result.data.map((r) => r.name)).toContain("Virtual A");
    expect(result.data.map((r) => r.name)).toContain("Virtual B");
    expect(result.pagination.total).toBe(2);
  });

  test("findAllByOrganization: returns empty for org with no virtual keys", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const result = await VirtualApiKeyModel.findAllByOrganization({
      organizationId: org.id,
      pagination: { limit: 20, offset: 0 },
    });
    expect(result.data).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
  });

  test("findAllByOrganization: filters by search and parent chat api key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const anthropicKey = await makeLlmProviderApiKey(org.id, secret.id, {
      name: "Anthropic Parent",
      provider: "anthropic",
    });
    const openAiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      name: "OpenAI Parent",
      provider: "openai",
    });

    await VirtualApiKeyModel.create({
      chatApiKeyId: anthropicKey.id,
      name: "Primary Virtual Key",
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: openAiKey.id,
      name: "Backup Virtual Key",
    });

    const result = await VirtualApiKeyModel.findAllByOrganization({
      organizationId: org.id,
      pagination: { limit: 20, offset: 0 },
      search: "primary",
      chatApiKeyId: anthropicKey.id,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].name).toBe("Primary Virtual Key");
    expect(result.data[0].parentKeyName).toBe("Anthropic Parent");
    expect(result.pagination.total).toBe(1);
  });

  test("findAllByOrganization: treats LIKE wildcard characters in search as literals", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      name: "Parent Key",
      provider: "anthropic",
    });

    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Virtual%Key",
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Virtual Alpha Key",
    });

    const result = await VirtualApiKeyModel.findAllByOrganization({
      organizationId: org.id,
      pagination: { limit: 20, offset: 0 },
      search: "%",
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].name).toBe("Virtual%Key");
    expect(result.pagination.total).toBe(1);
  });

  test("findAllByOrganization: applies scope visibility for non-admin users", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser({ email: "owner@test.com" });
    const otherUser = await makeUser({ email: "other@test.com" });
    const team = await makeTeam(org.id, owner.id, { name: "Platform Team" });
    const outsiderTeam = await makeTeam(org.id, owner.id, {
      name: "Other Team",
    });
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Org Key",
      scope: "org",
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "My Personal Key",
      scope: "personal",
      authorId: owner.id,
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Other Personal Key",
      scope: "personal",
      authorId: otherUser.id,
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "My Team Key",
      scope: "team",
      authorId: owner.id,
      teamIds: [team.id],
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Other Team Key",
      scope: "team",
      authorId: owner.id,
      teamIds: [outsiderTeam.id],
    });

    const result = await VirtualApiKeyModel.findAllByOrganization({
      organizationId: org.id,
      pagination: { limit: 20, offset: 0 },
      userId: owner.id,
      userTeamIds: [team.id],
      isAdmin: false,
    });

    expect(result.data.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Org Key", "My Personal Key", "My Team Key"]),
    );
    expect(result.data.map((item) => item.name)).not.toContain(
      "Other Personal Key",
    );
    expect(result.data.map((item) => item.name)).not.toContain(
      "Other Team Key",
    );
  });

  test("findAllByOrganization: admin can see all scopes", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const otherUser = await makeUser({ email: "other-admin@test.com" });
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Org Key",
      scope: "org",
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Other Personal Key",
      scope: "personal",
      authorId: otherUser.id,
    });

    const result = await VirtualApiKeyModel.findAllByOrganization({
      organizationId: org.id,
      pagination: { limit: 20, offset: 0 },
      userId: user.id,
      userTeamIds: [],
      isAdmin: true,
    });

    expect(result.data.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Org Key", "Other Personal Key"]),
    );
  });

  test("update: updates scope, teams, and expiration", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);
    const futureDate = new Date(Date.now() + 3600_000);

    const { virtualKey } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Before",
      scope: "personal",
      authorId: user.id,
    });

    const updated = await VirtualApiKeyModel.update({
      id: virtualKey.id,
      name: "After",
      expiresAt: futureDate,
      scope: "team",
      authorId: user.id,
      teamIds: [team.id],
      modelRouterProviderApiKeys: [],
    });

    expect(updated?.name).toBe("After");
    expect(updated?.scope).toBe("team");
    expect(updated?.expiresAt?.getTime()).toBe(futureDate.getTime());
    expect(
      await VirtualApiKeyModel.getTeamIdsForVirtualApiKey(virtualKey.id),
    ).toEqual([team.id]);
  });
});
