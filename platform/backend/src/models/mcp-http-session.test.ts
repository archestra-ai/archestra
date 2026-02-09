import { describe, expect, test } from "@/test";
import McpHttpSessionModel from "./mcp-http-session";

describe("McpHttpSessionModel", () => {
  describe("findByConnectionKey", () => {
    test("returns null for missing key", async () => {
      const result =
        await McpHttpSessionModel.findByConnectionKey("non-existent-key");
      expect(result).toBeNull();
    });

    test("returns session ID after upsert", async () => {
      await McpHttpSessionModel.upsert("catalog:server:agent:conv", "sess-abc");

      const result = await McpHttpSessionModel.findByConnectionKey(
        "catalog:server:agent:conv",
      );
      expect(result).toBe("sess-abc");
    });
  });

  describe("upsert", () => {
    test("creates new record", async () => {
      await McpHttpSessionModel.upsert("key-1", "session-1");

      const result = await McpHttpSessionModel.findByConnectionKey("key-1");
      expect(result).toBe("session-1");
    });

    test("updates existing record on conflict", async () => {
      await McpHttpSessionModel.upsert("key-1", "session-old");
      await McpHttpSessionModel.upsert("key-1", "session-new");

      const result = await McpHttpSessionModel.findByConnectionKey("key-1");
      expect(result).toBe("session-new");
    });

    test("different keys get different sessions", async () => {
      await McpHttpSessionModel.upsert("key-a", "session-a");
      await McpHttpSessionModel.upsert("key-b", "session-b");

      const resultA = await McpHttpSessionModel.findByConnectionKey("key-a");
      const resultB = await McpHttpSessionModel.findByConnectionKey("key-b");

      expect(resultA).toBe("session-a");
      expect(resultB).toBe("session-b");
    });
  });

  describe("deleteByConnectionKey", () => {
    test("removes existing record", async () => {
      await McpHttpSessionModel.upsert("key-1", "session-1");
      await McpHttpSessionModel.deleteByConnectionKey("key-1");

      const result = await McpHttpSessionModel.findByConnectionKey("key-1");
      expect(result).toBeNull();
    });

    test("does not throw for non-existent key", async () => {
      await expect(
        McpHttpSessionModel.deleteByConnectionKey("non-existent"),
      ).resolves.not.toThrow();
    });

    test("does not affect other keys", async () => {
      await McpHttpSessionModel.upsert("key-a", "session-a");
      await McpHttpSessionModel.upsert("key-b", "session-b");

      await McpHttpSessionModel.deleteByConnectionKey("key-a");

      const resultA = await McpHttpSessionModel.findByConnectionKey("key-a");
      const resultB = await McpHttpSessionModel.findByConnectionKey("key-b");

      expect(resultA).toBeNull();
      expect(resultB).toBe("session-b");
    });
  });

  describe("deleteStaleSession", () => {
    test("deletes the session record", async () => {
      await McpHttpSessionModel.upsert("stale-key", "stale-session");
      await McpHttpSessionModel.deleteStaleSession("stale-key");

      const result = await McpHttpSessionModel.findByConnectionKey("stale-key");
      expect(result).toBeNull();
    });
  });

  describe("deleteExpired", () => {
    test("deletes sessions older than TTL", async () => {
      // Insert a session with an old timestamp by upserting then manually updating
      await McpHttpSessionModel.upsert("old-key", "old-session");

      // Backdate the updatedAt by directly updating the DB
      const { eq } = await import("drizzle-orm");
      const { default: db, schema } = await import("@/database");
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await db
        .update(schema.mcpHttpSessionsTable)
        .set({ updatedAt: twoDaysAgo })
        .where(eq(schema.mcpHttpSessionsTable.connectionKey, "old-key"));

      // Insert a fresh session
      await McpHttpSessionModel.upsert("fresh-key", "fresh-session");

      const deletedCount = await McpHttpSessionModel.deleteExpired();

      expect(deletedCount).toBe(1);
      expect(
        await McpHttpSessionModel.findByConnectionKey("old-key"),
      ).toBeNull();
      expect(await McpHttpSessionModel.findByConnectionKey("fresh-key")).toBe(
        "fresh-session",
      );
    });

    test("returns 0 when no expired sessions exist", async () => {
      await McpHttpSessionModel.upsert("fresh-key", "fresh-session");

      const deletedCount = await McpHttpSessionModel.deleteExpired();
      expect(deletedCount).toBe(0);
    });
  });
});
