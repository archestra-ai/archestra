import { ARCHESTRA_MCP_CATALOG_ID } from "@shared";
import { describe, expect, test } from "@/test";
import { SelectInternalMcpCatalogSchema } from "@/types";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import McpCatalogLabelModel from "./mcp-catalog-label";

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

  describe("labels integration", () => {
    test("create with labels returns labels", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "catalog-with-labels",
        serverType: "remote",
        labels: [
          { key: "category", value: "database" },
          { key: "tier", value: "premium" },
        ],
      });

      expect(catalog.labels).toHaveLength(2);
      expect(catalog.labels[0].key).toBe("category");
      expect(catalog.labels[0].value).toBe("database");
      expect(catalog.labels[1].key).toBe("tier");
      expect(catalog.labels[1].value).toBe("premium");
    });

    test("create without labels returns empty labels array", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "catalog-no-labels",
        serverType: "remote",
      });

      expect(catalog.labels).toEqual([]);
    });

    test("findById returns labels", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "catalog-find-by-id-labels",
        serverType: "remote",
        labels: [{ key: "env", value: "prod" }],
      });

      const found = await InternalMcpCatalogModel.findById(catalog.id, {
        expandSecrets: false,
      });

      expect(found).not.toBeNull();
      expect(found?.labels).toHaveLength(1);
      expect(found?.labels[0].key).toBe("env");
      expect(found?.labels[0].value).toBe("prod");
    });

    test("findByIdWithResolvedSecrets returns labels", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "catalog-resolved-secrets-labels",
        serverType: "remote",
        labels: [{ key: "scope", value: "internal" }],
      });

      const found = await InternalMcpCatalogModel.findByIdWithResolvedSecrets(
        catalog.id,
      );

      expect(found).not.toBeNull();
      expect(found?.labels).toHaveLength(1);
      expect(found?.labels[0].key).toBe("scope");
      expect(found?.labels[0].value).toBe("internal");
    });

    test("findByName returns labels", async () => {
      const uniqueName = `catalog-find-by-name-${Date.now()}`;
      await InternalMcpCatalogModel.create({
        name: uniqueName,
        serverType: "remote",
        labels: [{ key: "type", value: "ai" }],
      });

      const found = await InternalMcpCatalogModel.findByName(uniqueName);

      expect(found).not.toBeNull();
      expect(found?.labels).toHaveLength(1);
      expect(found?.labels[0].key).toBe("type");
      expect(found?.labels[0].value).toBe("ai");
    });

    test("findAll returns labels for all items", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "catalog-find-all-labels",
        serverType: "remote",
        labels: [
          { key: "region", value: "us-east" },
          { key: "team", value: "platform" },
        ],
      });

      const all = await InternalMcpCatalogModel.findAll({
        expandSecrets: false,
      });
      const found = all.find((item) => item.id === catalog.id);

      expect(found).toBeDefined();
      expect(found?.labels).toHaveLength(2);
      expect(found?.labels[0].key).toBe("region");
      expect(found?.labels[1].key).toBe("team");
    });

    test("searchByQuery returns labels", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "unique-searchable-catalog-xyz",
        serverType: "remote",
        labels: [{ key: "search-label", value: "found" }],
      });

      const results = await InternalMcpCatalogModel.searchByQuery(
        "unique-searchable-catalog-xyz",
        { expandSecrets: false },
      );

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(catalog.id);
      expect(results[0].labels).toHaveLength(1);
      expect(results[0].labels[0].key).toBe("search-label");
    });

    test("getByIds returns labels", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "catalog-get-by-ids-labels",
        serverType: "remote",
        labels: [{ key: "bulk", value: "yes" }],
      });

      const map = await InternalMcpCatalogModel.getByIds([catalog.id]);
      const found = map.get(catalog.id);

      expect(found).toBeDefined();
      expect(found?.labels).toHaveLength(1);
      expect(found?.labels[0].key).toBe("bulk");
      expect(found?.labels[0].value).toBe("yes");
    });

    test("update with labels replaces existing labels", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "catalog-update-labels",
        serverType: "remote",
        labels: [{ key: "version", value: "v1" }],
      });

      const updated = await InternalMcpCatalogModel.update(catalog.id, {
        labels: [
          { key: "version", value: "v2" },
          { key: "status", value: "active" },
        ],
      });

      expect(updated).not.toBeNull();
      expect(updated?.labels).toHaveLength(2);
      expect(updated?.labels[0].key).toBe("status");
      expect(updated?.labels[0].value).toBe("active");
      expect(updated?.labels[1].key).toBe("version");
      expect(updated?.labels[1].value).toBe("v2");
    });

    test("update without labels does not touch existing labels", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "catalog-update-no-labels",
        serverType: "remote",
        labels: [{ key: "keep", value: "me" }],
      });

      const updated = await InternalMcpCatalogModel.update(catalog.id, {
        name: "catalog-update-no-labels-renamed",
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe("catalog-update-no-labels-renamed");
      expect(updated?.labels).toHaveLength(1);
      expect(updated?.labels[0].key).toBe("keep");
      expect(updated?.labels[0].value).toBe("me");
    });

    test("delete cascades labels", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "catalog-delete-cascade",
        serverType: "remote",
        labels: [{ key: "delete-me", value: "cascade" }],
      });

      // Verify labels exist
      const labelsBefore = await McpCatalogLabelModel.getLabelsForCatalogItem(
        catalog.id,
      );
      expect(labelsBefore).toHaveLength(1);

      await InternalMcpCatalogModel.delete(catalog.id);

      // Labels should be gone (cascade delete)
      const labelsAfter = await McpCatalogLabelModel.getLabelsForCatalogItem(
        catalog.id,
      );
      expect(labelsAfter).toHaveLength(0);
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
