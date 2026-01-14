import { ARCHESTRA_MCP_CATALOG_ID } from "@shared";
import { describe, expect, test } from "@/test";
import { SelectInternalMcpCatalogSchema } from "@/types/mcp-catalog";
import InternalMcpCatalogModel from "./internal-mcp-catalog";

describe("InternalMcpCatalogModel", () => {
  describe("findAll with expandSecrets", () => {
    test("expands secrets by default (expandSecrets: true)", async ({
      makeSecret,
    }) => {
      // Create secrets
      const oauthSecret = await makeSecret({
        name: "oauth-secret",
        secret: { client_secret: "test-client-secret-123" },
      });
      const envSecret = await makeSecret({
        name: "env-secret",
        secret: {
          API_KEY: "test-api-key-456",
          DB_PASSWORD: "test-db-pass-789",
        },
      });

      // Create catalog item with secret references using the model directly
      const catalog = await InternalMcpCatalogModel.create({
        name: "test-catalog-with-secrets",
        serverType: "remote",
        clientSecretId: oauthSecret.id,
        localConfigSecretId: envSecret.id,
        oauthConfig: {
          name: "Test OAuth",
          server_url: "https://example.com",
          client_id: "test-client-id",
          redirect_uris: ["http://localhost:3000/oauth/callback"],
          scopes: ["read", "write"],
          default_scopes: ["read"],
          supports_resource_metadata: false,
        },
        localConfig: {
          command: "npx",
          arguments: ["-y", "@test/server"],
          environment: [
            {
              key: "API_KEY",
              type: "secret",
              required: true,
              description: "API Key",
              promptOnInstallation: false,
            },
            {
              key: "DB_PASSWORD",
              type: "secret",
              required: true,
              description: "Database Password",
              promptOnInstallation: false,
            },
          ],
        },
      });

      // Call findAll which should expand secrets
      const catalogItems = await InternalMcpCatalogModel.findAll();
      const foundCatalog = catalogItems.find((item) => item.id === catalog.id);

      expect(foundCatalog).toBeDefined();
      expect(foundCatalog?.oauthConfig?.client_secret).toBe(
        "test-client-secret-123",
      );
      expect(foundCatalog?.localConfig?.environment?.[0].value).toBe(
        "test-api-key-456",
      );
      expect(foundCatalog?.localConfig?.environment?.[1].value).toBe(
        "test-db-pass-789",
      );
    });

    test("does not expand secrets when expandSecrets: false", async ({
      makeSecret,
    }) => {
      // Create secrets
      const oauthSecret = await makeSecret({
        name: "oauth-secret-no-expand",
        secret: { client_secret: "secret-should-not-appear" },
      });
      const envSecret = await makeSecret({
        name: "env-secret-no-expand",
        secret: {
          API_KEY: "key-should-not-appear",
        },
      });

      // Create catalog item with secret references
      const catalog = await InternalMcpCatalogModel.create({
        name: "test-catalog-no-expand",
        serverType: "remote",
        clientSecretId: oauthSecret.id,
        localConfigSecretId: envSecret.id,
        oauthConfig: {
          name: "Test OAuth",
          server_url: "https://example.com",
          client_id: "test-client-id",
          redirect_uris: ["http://localhost:3000/oauth/callback"],
          scopes: ["read"],
          default_scopes: ["read"],
          supports_resource_metadata: false,
        },
        localConfig: {
          command: "npx",
          arguments: ["-y", "@test/server"],
          environment: [
            {
              key: "API_KEY",
              type: "secret",
              required: true,
              description: "API Key",
              promptOnInstallation: false,
            },
          ],
        },
      });

      // Call findAll with expandSecrets: false
      const catalogItems = await InternalMcpCatalogModel.findAll({
        expandSecrets: false,
      });
      const foundCatalog = catalogItems.find((item) => item.id === catalog.id);

      expect(foundCatalog).toBeDefined();
      // Secrets should NOT be expanded
      expect(foundCatalog?.oauthConfig?.client_secret).toBeUndefined();
      expect(foundCatalog?.localConfig?.environment?.[0].value).toBeUndefined();
    });
  });

  describe("getByIds", () => {
    test("returns Map of catalog items by ID", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog1 = await makeInternalMcpCatalog({
        name: "test-catalog-1",
        serverType: "remote",
      });
      const catalog2 = await makeInternalMcpCatalog({
        name: "test-catalog-2",
        serverType: "local",
      });
      const nonExistentId = "00000000-0000-0000-0000-000000000000";

      const catalogItemsMap = await InternalMcpCatalogModel.getByIds([
        catalog1.id,
        catalog2.id,
        nonExistentId,
      ]);

      expect(catalogItemsMap).toBeInstanceOf(Map);
      expect(catalogItemsMap.size).toBe(2);
      expect(catalogItemsMap.has(catalog1.id)).toBe(true);
      expect(catalogItemsMap.has(catalog2.id)).toBe(true);
      expect(catalogItemsMap.has(nonExistentId)).toBe(false);

      const item1 = catalogItemsMap.get(catalog1.id);
      expect(item1).toBeDefined();
      expect(item1?.id).toBe(catalog1.id);
      expect(item1?.name).toBe("test-catalog-1");
      expect(item1?.serverType).toBe("remote");

      const item2 = catalogItemsMap.get(catalog2.id);
      expect(item2).toBeDefined();
      expect(item2?.id).toBe(catalog2.id);
      expect(item2?.name).toBe("test-catalog-2");
      expect(item2?.serverType).toBe("local");
    });

    test("returns empty Map for empty input", async () => {
      const catalogItemsMap = await InternalMcpCatalogModel.getByIds([]);

      expect(catalogItemsMap).toBeInstanceOf(Map);
      expect(catalogItemsMap.size).toBe(0);
    });

    test("returns empty Map when no catalog items exist", async () => {
      const nonExistentId1 = "00000000-0000-4000-8000-000000000099";
      const nonExistentId2 = "00000000-0000-4000-8000-000000000098";

      const catalogItemsMap = await InternalMcpCatalogModel.getByIds([
        nonExistentId1,
        nonExistentId2,
      ]);

      expect(catalogItemsMap).toBeInstanceOf(Map);
      expect(catalogItemsMap.size).toBe(0);
    });

    test("handles duplicate IDs in input", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        name: "test-catalog",
        serverType: "remote",
      });

      const catalogItemsMap = await InternalMcpCatalogModel.getByIds([
        catalog.id,
        catalog.id,
        catalog.id,
      ]);

      expect(catalogItemsMap.size).toBe(1);
      expect(catalogItemsMap.has(catalog.id)).toBe(true);
      expect(catalogItemsMap.get(catalog.id)?.id).toBe(catalog.id);
    });
  });

  describe("Archestra Catalog", () => {
    test("Archestra catalog validates against SelectInternalMcpCatalogSchema", async ({
      seedAndAssignArchestraTools,
      makeAgent,
    }) => {
      // Seed Archestra catalog and tools
      const agent = await makeAgent();
      await seedAndAssignArchestraTools(agent.id);

      // Find the Archestra catalog via findById
      const archestra = await InternalMcpCatalogModel.findById(
        ARCHESTRA_MCP_CATALOG_ID,
      );

      expect(archestra).not.toBeNull();

      // Validate against schema
      const result = SelectInternalMcpCatalogSchema.safeParse(archestra);
      expect(result.success).toBe(true);
    });

    test("findAll includes Archestra catalog", async ({
      seedAndAssignArchestraTools,
      makeAgent,
    }) => {
      // Seed Archestra catalog and tools
      const agent = await makeAgent();
      await seedAndAssignArchestraTools(agent.id);

      const catalogItems = await InternalMcpCatalogModel.findAll({
        expandSecrets: false,
      });

      const archestraCatalog = catalogItems.find(
        (item) => item.id === ARCHESTRA_MCP_CATALOG_ID,
      );

      expect(archestraCatalog).toBeDefined();
      expect(archestraCatalog?.name).toBe("Archestra");
      expect(archestraCatalog?.serverType).toBe("builtin");
    });
  });
});
