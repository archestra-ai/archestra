import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import McpServerModel from "./mcp-server";

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
});
