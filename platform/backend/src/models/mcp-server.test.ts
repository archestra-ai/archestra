import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import McpServerModel from "./mcp-server";
import McpServerUserModel from "./mcp-server-user";

describe("McpServerModel", () => {
  describe("serverType field", () => {
    test("MCP servers store serverType correctly including builtin", async ({
      makeInternalMcpCatalog,
    }) => {
      // Create catalogs for each server type
      const localCatalog = await makeInternalMcpCatalog({
        name: "Local Test Catalog",
        serverType: "local",
        localConfig: { command: "node", arguments: ["server.js"] },
      });

      const remoteCatalog = await makeInternalMcpCatalog({
        name: "Remote Test Catalog",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
      });

      const builtinCatalog = await makeInternalMcpCatalog({
        name: "Builtin Test Catalog",
        serverType: "builtin",
      });

      // Create MCP server instances with different types
      const [localServer] = await db
        .insert(schema.mcpServersTable)
        .values({
          name: "Local Server",
          serverType: "local",
          catalogId: localCatalog.id,
        })
        .returning();

      const [remoteServer] = await db
        .insert(schema.mcpServersTable)
        .values({
          name: "Remote Server",
          serverType: "remote",
          catalogId: remoteCatalog.id,
        })
        .returning();

      const [builtinServer] = await db
        .insert(schema.mcpServersTable)
        .values({
          name: "Builtin Server",
          serverType: "builtin",
          catalogId: builtinCatalog.id,
        })
        .returning();

      // Verify serverTypes are stored correctly
      expect(localServer.serverType).toBe("local");
      expect(remoteServer.serverType).toBe("remote");
      expect(builtinServer.serverType).toBe("builtin");

      // Verify we can find them by ID
      const foundLocal = await McpServerModel.findById(localServer.id);
      const foundRemote = await McpServerModel.findById(remoteServer.id);
      const foundBuiltin = await McpServerModel.findById(builtinServer.id);

      expect(foundLocal?.serverType).toBe("local");
      expect(foundRemote?.serverType).toBe("remote");
      expect(foundBuiltin?.serverType).toBe("builtin");
    });
  });

  describe("findByIdsBasic", () => {
    test("returns basic MCP server records for given IDs", async ({
      makeMcpServer,
    }) => {
      const server1 = await makeMcpServer();
      const server2 = await makeMcpServer();
      await makeMcpServer(); // not requested

      const results = await McpServerModel.findByIdsBasic([
        server1.id,
        server2.id,
      ]);

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.id).sort()).toEqual(
        [server1.id, server2.id].sort(),
      );
    });

    test("returns empty array for empty input", async () => {
      const results = await McpServerModel.findByIdsBasic([]);
      expect(results).toEqual([]);
    });

    test("returns empty array for non-existent IDs", async () => {
      const results = await McpServerModel.findByIdsBasic([
        crypto.randomUUID(),
      ]);
      expect(results).toEqual([]);
    });
  });

  describe("findAll", () => {
    test("returns servers with user details from combined query", async ({
      makeMcpServer,
      makeUser,
    }) => {
      const user1 = await makeUser();
      const user2 = await makeUser();
      const server = await makeMcpServer();

      // Assign users to the server
      await McpServerUserModel.assignUserToMcpServer(server.id, user1.id);
      await McpServerUserModel.assignUserToMcpServer(server.id, user2.id);

      // findAll as admin (no access control)
      const allServers = await McpServerModel.findAll(undefined, true);
      const found = allServers.find((s) => s.id === server.id);

      expect(found).toBeDefined();
      if (!found) return;
      expect(found.users).toHaveLength(2);
      expect(found.users).toContain(user1.id);
      expect(found.users).toContain(user2.id);
      expect(found.userDetails).toHaveLength(2);
      expect(found.userDetails?.map((u) => u.userId).sort()).toEqual(
        [user1.id, user2.id].sort(),
      );
    });

    test("returns servers with no users correctly", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();

      const allServers = await McpServerModel.findAll(undefined, true);
      const found = allServers.find((s) => s.id === server.id);

      expect(found).toBeDefined();
      if (!found) return;
      expect(found.users).toHaveLength(0);
      expect(found.userDetails).toHaveLength(0);
    });

    test("does not duplicate servers when multiple users assigned", async ({
      makeMcpServer,
      makeUser,
    }) => {
      const user1 = await makeUser();
      const user2 = await makeUser();
      const user3 = await makeUser();
      const server = await makeMcpServer();

      await McpServerUserModel.assignUserToMcpServer(server.id, user1.id);
      await McpServerUserModel.assignUserToMcpServer(server.id, user2.id);
      await McpServerUserModel.assignUserToMcpServer(server.id, user3.id);

      const allServers = await McpServerModel.findAll(undefined, true);
      // Ensure the server only appears once despite 3 users (LEFT JOIN dedup)
      const matching = allServers.filter((s) => s.id === server.id);
      expect(matching).toHaveLength(1);
      expect(matching[0].users).toHaveLength(3);
    });
  });
});
