import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import ApiKeyModel from "./api-key";

describe("ApiKeyModel", () => {
  describe("listByUserId", () => {
    test("returns only the current user's API keys in reverse chronological order", async ({
      makeUser,
    }) => {
      const user = await makeUser();
      const otherUser = await makeUser();

      await db.insert(schema.apikeysTable).values([
        {
          id: crypto.randomUUID(),
          configId: "default",
          name: "Older key",
          key: "hashed-older",
          referenceId: user.id,
          enabled: true,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          permissions: JSON.stringify({ agent: ["read"] }),
          metadata: JSON.stringify({ source: "test" }),
        },
        {
          id: crypto.randomUUID(),
          configId: "default",
          name: "Newest key",
          key: "hashed-newest",
          referenceId: user.id,
          enabled: true,
          createdAt: new Date("2026-02-01T00:00:00.000Z"),
          updatedAt: new Date("2026-02-01T00:00:00.000Z"),
        },
        {
          id: crypto.randomUUID(),
          configId: "default",
          name: "Other user's key",
          key: "hashed-other",
          referenceId: otherUser.id,
          enabled: true,
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          updatedAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ]);

      const apiKeys = await ApiKeyModel.listByUserId(user.id);

      expect(apiKeys).toHaveLength(2);
      expect(apiKeys.map((apiKey) => apiKey.name)).toEqual([
        "Newest key",
        "Older key",
      ]);
      expect(apiKeys[1]?.permissions).toEqual({ agent: ["read"] });
      expect(apiKeys[1]?.metadata).toEqual({ source: "test" });
    });

    test("returns null metadata and permissions for malformed JSON values", async ({
      makeUser,
    }) => {
      const user = await makeUser();

      await db.insert(schema.apikeysTable).values({
        id: crypto.randomUUID(),
        configId: "default",
        name: "Broken key",
        key: "hashed-broken",
        referenceId: user.id,
        enabled: true,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date("2026-02-01T00:00:00.000Z"),
        permissions: "{not-json}",
        metadata: "{not-json}",
      });

      const [apiKey] = await ApiKeyModel.listByUserId(user.id);

      expect(apiKey?.permissions).toBeNull();
      expect(apiKey?.metadata).toBeNull();
    });
  });

  describe("findByIdForUser", () => {
    test("returns null when the key belongs to a different user", async ({
      makeUser,
    }) => {
      const owner = await makeUser();
      const otherUser = await makeUser();
      const apiKeyId = crypto.randomUUID();

      await db.insert(schema.apikeysTable).values({
        id: apiKeyId,
        configId: "default",
        name: "Owner key",
        key: "hashed-owner",
        referenceId: owner.id,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const apiKey = await ApiKeyModel.findByIdForUser(apiKeyId, otherUser.id);

      expect(apiKey).toBeNull();
    });
  });
});
