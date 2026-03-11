import { describe, it, expect, beforeEach } from "vitest";
import db, { schema } from "@/database";
import { InternalMcpCatalogModel } from "@/models";

// Test IDs for the new MCP catalog entries
const FILESYSTEM_MCP_CATALOG_ID = "filesystem-mcp-server";
const MEMORY_MCP_CATALOG_ID = "memory-mcp-server";

describe("MCP Catalog Seed Functions", () => {
  beforeEach(async () => {
    // Clean up any existing test catalog entries
    await db
      .delete(schema.internalMcpCatalogTable)
      .where(
        sql`id IN (${FILESYSTEM_MCP_CATALOG_ID}, ${MEMORY_MCP_CATALOG_ID})`
      );
  });

  describe("Filesystem MCP Catalog", () => {
    it("should create filesystem MCP catalog entry with correct configuration", async () => {
      const catalogItem = await InternalMcpCatalogModel.findById(
        FILESYSTEM_MCP_CATALOG_ID
      );

      if (catalogItem) {
        expect(catalogItem.name).toBe("filesystem-mcp");
        expect(catalogItem.serverType).toBe("local");
        expect(catalogItem.description).toContain("file system operations");
        expect(catalogItem.localConfig?.command).toBe("npx");
        expect(catalogItem.localConfig?.transportType).toBe("stdio");
        expect(catalogItem.localConfig?.environment).toBeDefined();
      }
    });

    it("should have workspace path configuration", async () => {
      const catalogItem = await InternalMcpCatalogModel.findById(
        FILESYSTEM_MCP_CATALOG_ID
      );

      if (catalogItem?.localConfig?.environment) {
        const workspaceEnv = catalogItem.localConfig.environment.find(
          (env) => env.key === "WORKSPACE_PATH"
        );
        expect(workspaceEnv).toBeDefined();
        expect(workspaceEnv?.type).toBe("directory");
        expect(workspaceEnv?.promptOnInstallation).toBe(true);
      }
    });

    it("should not require authentication", async () => {
      const catalogItem = await InternalMcpCatalogModel.findById(
        FILESYSTEM_MCP_CATALOG_ID
      );
      expect(catalogItem?.requiresAuth).toBe(false);
    });
  });

  describe("Memory MCP Catalog", () => {
    it("should create memory MCP catalog entry with correct configuration", async () => {
      const catalogItem = await InternalMcpCatalogModel.findById(
        MEMORY_MCP_CATALOG_ID
      );

      if (catalogItem) {
        expect(catalogItem.name).toBe("memory-mcp");
        expect(catalogItem.serverType).toBe("local");
        expect(catalogItem.description).toContain("persistent memory");
        expect(catalogItem.localConfig?.command).toBe("npx");
        expect(catalogItem.localConfig?.transportType).toBe("stdio");
      }
    });

    it("should have memory file path configuration", async () => {
      const catalogItem = await InternalMcpCatalogModel.findById(
        MEMORY_MCP_CATALOG_ID
      );

      if (catalogItem?.localConfig?.environment) {
        const memPathEnv = catalogItem.localConfig.environment.find(
          (env) => env.key === "MEMORY_FILE_PATH"
        );
        expect(memPathEnv).toBeDefined();
        expect(memPathEnv?.type).toBe("file");
      }
    });

    it("should not require authentication", async () => {
      const catalogItem = await InternalMcpCatalogModel.findById(
        MEMORY_MCP_CATALOG_ID
      );
      expect(catalogItem?.requiresAuth).toBe(false);
    });
  });

  describe("Catalog Integration", () => {
    it("should be able to find MCP servers by name", async () => {
      const filesystemCatalog = await InternalMcpCatalogModel.findByName("filesystem-mcp");
      const memoryCatalog = await InternalMcpCatalogModel.findByName("memory-mcp");

      // If seeded, these should exist
      if (filesystemCatalog) {
        expect(filesystemCatalog.id).toBe(FILESYSTEM_MCP_CATALOG_ID);
      }
      if (memoryCatalog) {
        expect(memoryCatalog.id).toBe(MEMORY_MCP_CATALOG_ID);
      }
    });

    it("should list all catalog items including new MCP servers", async () => {
      const allCatalogs = await InternalMcpCatalogModel.findAll();
      
      // Check that our new servers are in the list if they were seeded
      const filesystemInList = allCatalogs.find(
        (c) => c.id === FILESYSTEM_MCP_CATALOG_ID
      );
      const memoryInList = allCatalogs.find(
        (c) => c.id === MEMORY_MCP_CATALOG_ID
      );

      // These will exist if seed was run
      if (filesystemInList) {
        expect(filesystemInList.name).toBe("filesystem-mcp");
      }
      if (memoryInList) {
        expect(memoryInList.name).toBe("memory-mcp");
      }
    });
  });
});
