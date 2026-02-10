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
      await McpHttpSessionModel.upsert({
        connectionKey: "catalog:server:agent:conv",
        sessionId: "sess-abc",
      });

      const result = await McpHttpSessionModel.findByConnectionKey(
        "catalog:server:agent:conv",
      );
      expect(result).toBe("sess-abc");
    });

    test("returns full session record with endpoint metadata", async () => {
      await McpHttpSessionModel.upsert({
        connectionKey: "catalog:server:agent:conv",
        sessionId: "sess-abc",
        sessionEndpointUrl: "http://10.0.0.11:8080/mcp",
        sessionEndpointPodName: "mcp-playwright-abc-123",
      });

      const result = await McpHttpSessionModel.findRecordByConnectionKey(
        "catalog:server:agent:conv",
      );
      expect(result).toEqual({
        sessionId: "sess-abc",
        sessionEndpointUrl: "http://10.0.0.11:8080/mcp",
        sessionEndpointPodName: "mcp-playwright-abc-123",
      });
    });
  });

  describe("upsert", () => {
    test("creates new record", async () => {
      await McpHttpSessionModel.upsert({
        connectionKey: "key-1",
        sessionId: "session-1",
      });

      const result = await McpHttpSessionModel.findByConnectionKey("key-1");
      expect(result).toBe("session-1");
    });

    test("updates existing record on conflict", async () => {
      await McpHttpSessionModel.upsert({
        connectionKey: "key-1",
        sessionId: "session-old",
        sessionEndpointUrl: "http://10.0.0.11:8080/mcp",
      });
      await McpHttpSessionModel.upsert({
        connectionKey: "key-1",
        sessionId: "session-new",
        sessionEndpointUrl: "http://10.0.0.12:8080/mcp",
        sessionEndpointPodName: "mcp-playwright-def-456",
      });

      const result =
        await McpHttpSessionModel.findRecordByConnectionKey("key-1");
      expect(result).toEqual({
        sessionId: "session-new",
        sessionEndpointUrl: "http://10.0.0.12:8080/mcp",
        sessionEndpointPodName: "mcp-playwright-def-456",
      });
    });

    test("different keys get different sessions", async () => {
      await McpHttpSessionModel.upsert({
        connectionKey: "key-a",
        sessionId: "session-a",
      });
      await McpHttpSessionModel.upsert({
        connectionKey: "key-b",
        sessionId: "session-b",
      });

      const resultA = await McpHttpSessionModel.findByConnectionKey("key-a");
      const resultB = await McpHttpSessionModel.findByConnectionKey("key-b");

      expect(resultA).toBe("session-a");
      expect(resultB).toBe("session-b");
    });
  });

  describe("deleteByConnectionKey", () => {
    test("removes existing record", async () => {
      await McpHttpSessionModel.upsert({
        connectionKey: "key-1",
        sessionId: "session-1",
      });
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
      await McpHttpSessionModel.upsert({
        connectionKey: "key-a",
        sessionId: "session-a",
      });
      await McpHttpSessionModel.upsert({
        connectionKey: "key-b",
        sessionId: "session-b",
      });

      await McpHttpSessionModel.deleteByConnectionKey("key-a");

      const resultA = await McpHttpSessionModel.findByConnectionKey("key-a");
      const resultB = await McpHttpSessionModel.findByConnectionKey("key-b");

      expect(resultA).toBeNull();
      expect(resultB).toBe("session-b");
    });
  });

  describe("deleteStaleSession", () => {
    test("deletes the session record", async () => {
      await McpHttpSessionModel.upsert({
        connectionKey: "stale-key",
        sessionId: "stale-session",
      });
      await McpHttpSessionModel.deleteStaleSession("stale-key");

      const result = await McpHttpSessionModel.findByConnectionKey("stale-key");
      expect(result).toBeNull();
    });
  });

  describe("deleteByMcpServerId", () => {
    test("deletes sessions with matching mcpServerId in connection key", async () => {
      // Create sessions with different formats containing the same mcpServerId
      await McpHttpSessionModel.upsert({
        connectionKey: "catalog1:server-abc:agent1:conv1",
        sessionId: "sess-1",
      });
      await McpHttpSessionModel.upsert({
        connectionKey: "catalog1:server-abc:agent2:conv2",
        sessionId: "sess-2",
      });
      await McpHttpSessionModel.upsert({
        connectionKey: "catalog1:server-abc",
        sessionId: "sess-3",
      });

      const deleted =
        await McpHttpSessionModel.deleteByMcpServerId("server-abc");
      expect(deleted).toBe(3);

      expect(
        await McpHttpSessionModel.findByConnectionKey(
          "catalog1:server-abc:agent1:conv1",
        ),
      ).toBeNull();
      expect(
        await McpHttpSessionModel.findByConnectionKey(
          "catalog1:server-abc:agent2:conv2",
        ),
      ).toBeNull();
      expect(
        await McpHttpSessionModel.findByConnectionKey("catalog1:server-abc"),
      ).toBeNull();
    });

    test("does not delete sessions for other servers", async () => {
      await McpHttpSessionModel.upsert({
        connectionKey: "catalog1:server-abc:agent1:conv1",
        sessionId: "sess-1",
      });
      await McpHttpSessionModel.upsert({
        connectionKey: "catalog1:server-xyz:agent1:conv1",
        sessionId: "sess-2",
      });

      const deleted =
        await McpHttpSessionModel.deleteByMcpServerId("server-abc");
      expect(deleted).toBe(1);

      // Other server's session should remain
      expect(
        await McpHttpSessionModel.findByConnectionKey(
          "catalog1:server-xyz:agent1:conv1",
        ),
      ).toBe("sess-2");
    });

    test("returns 0 when no sessions match", async () => {
      await McpHttpSessionModel.upsert({
        connectionKey: "catalog1:server-xyz:agent1:conv1",
        sessionId: "sess-1",
      });

      const deleted =
        await McpHttpSessionModel.deleteByMcpServerId("server-nonexistent");
      expect(deleted).toBe(0);
    });
  });

  describe("deleteExpired", () => {
    test("deletes sessions older than TTL", async () => {
      // Insert a session with an old timestamp by upserting then manually updating
      await McpHttpSessionModel.upsert({
        connectionKey: "old-key",
        sessionId: "old-session",
      });

      // Backdate the updatedAt by directly updating the DB
      const { eq } = await import("drizzle-orm");
      const { default: db, schema } = await import("@/database");
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await db
        .update(schema.mcpHttpSessionsTable)
        .set({ updatedAt: twoDaysAgo })
        .where(eq(schema.mcpHttpSessionsTable.connectionKey, "old-key"));

      // Insert a fresh session
      await McpHttpSessionModel.upsert({
        connectionKey: "fresh-key",
        sessionId: "fresh-session",
      });

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
      await McpHttpSessionModel.upsert({
        connectionKey: "fresh-key",
        sessionId: "fresh-session",
      });

      const deletedCount = await McpHttpSessionModel.deleteExpired();
      expect(deletedCount).toBe(0);
    });
  });
});
