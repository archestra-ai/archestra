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
    makeChatApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-real-key" } });
    const chatApiKey = await makeChatApiKey(org.id, secret.id);

    const { virtualKey, value } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Test Virtual Key",
    });

    expect(virtualKey.id).toBeDefined();
    expect(virtualKey.chatApiKeyId).toBe(chatApiKey.id);
    expect(virtualKey.name).toBe("Test Virtual Key");
    expect(virtualKey.expiresAt).toBeNull();
    expect(value).toMatch(/^archestra_[a-f0-9]{64}$/);
    expect(virtualKey.tokenStart).toBe(value.substring(0, 14));
  });

  test("create: stores expiresAt when provided", async ({
    makeOrganization,
    makeSecret,
    makeChatApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-real-key" } });
    const chatApiKey = await makeChatApiKey(org.id, secret.id);

    const futureDate = new Date(Date.now() + 86400_000);
    const { virtualKey } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Expiring Key",
      expiresAt: futureDate,
    });

    expect(virtualKey.expiresAt).toBeInstanceOf(Date);
    expect(virtualKey.expiresAt?.getTime()).toBe(futureDate.getTime());
  });

  // =========================================================================
  // findByChatApiKeyId
  // =========================================================================

  test("findByChatApiKeyId: returns all virtual keys for a chat API key", async ({
    makeOrganization,
    makeSecret,
    makeChatApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeChatApiKey(org.id, secret.id);

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

  // =========================================================================
  // findById
  // =========================================================================

  test("findById: returns the virtual key", async ({
    makeOrganization,
    makeSecret,
    makeChatApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeChatApiKey(org.id, secret.id);

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
    makeChatApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeChatApiKey(org.id, secret.id);

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
    makeChatApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeChatApiKey(org.id, secret.id);

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
    makeChatApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeChatApiKey(org.id, secret.id);

    const { value } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Validate Me",
    });

    const result = await VirtualApiKeyModel.validateToken(value);
    expect(result).not.toBeNull();
    expect(result?.virtualKey.name).toBe("Validate Me");
    expect(result?.chatApiKey.id).toBe(chatApiKey.id);
  });

  test("validateToken: returns null for invalid token", async () => {
    const result = await VirtualApiKeyModel.validateToken(
      "archestra_0000000000000000000000000000",
    );
    expect(result).toBeNull();
  });

  test("validateToken: returns null for non-archestra token", async () => {
    const result = await VirtualApiKeyModel.validateToken("sk-some-random-key");
    expect(result).toBeNull();
  });

  // =========================================================================
  // findAllByOrganization
  // =========================================================================

  test("findAllByOrganization: returns virtual keys with parent API key info", async ({
    makeOrganization,
    makeSecret,
    makeChatApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeChatApiKey(org.id, secret.id, {
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
});
