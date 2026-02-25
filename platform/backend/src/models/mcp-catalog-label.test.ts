import { describe, expect, test } from "@/test";
import AgentLabelModel from "./agent-label";
import McpCatalogLabelModel from "./mcp-catalog-label";

describe("McpCatalogLabelModel", () => {
  describe("syncCatalogLabels", () => {
    test("syncs labels for a catalog item", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog();

      await McpCatalogLabelModel.syncCatalogLabels(catalog.id, [
        { key: "category", value: "database" },
        { key: "tier", value: "premium" },
      ]);

      const labels = await McpCatalogLabelModel.getLabelsForCatalogItem(
        catalog.id,
      );

      expect(labels).toHaveLength(2);
      expect(labels[0].key).toBe("category");
      expect(labels[0].value).toBe("database");
      expect(labels[1].key).toBe("tier");
      expect(labels[1].value).toBe("premium");
    });

    test("replaces existing labels when syncing", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog();

      await McpCatalogLabelModel.syncCatalogLabels(catalog.id, [
        { key: "category", value: "database" },
      ]);

      await McpCatalogLabelModel.syncCatalogLabels(catalog.id, [
        { key: "category", value: "ai" },
        { key: "tier", value: "free" },
      ]);

      const labels = await McpCatalogLabelModel.getLabelsForCatalogItem(
        catalog.id,
      );

      expect(labels).toHaveLength(2);
      expect(labels[0].key).toBe("category");
      expect(labels[0].value).toBe("ai");
      expect(labels[1].key).toBe("tier");
      expect(labels[1].value).toBe("free");
    });

    test("clears all labels when syncing with empty array", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog();

      await McpCatalogLabelModel.syncCatalogLabels(catalog.id, [
        { key: "category", value: "database" },
      ]);

      await McpCatalogLabelModel.syncCatalogLabels(catalog.id, []);

      const labels = await McpCatalogLabelModel.getLabelsForCatalogItem(
        catalog.id,
      );
      expect(labels).toHaveLength(0);
    });
  });

  describe("getLabelsForCatalogItems", () => {
    test("returns labels for multiple catalog items in bulk", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog1 = await makeInternalMcpCatalog();
      const catalog2 = await makeInternalMcpCatalog();
      const catalog3 = await makeInternalMcpCatalog();

      await McpCatalogLabelModel.syncCatalogLabels(catalog1.id, [
        { key: "category", value: "database" },
        { key: "tier", value: "premium" },
      ]);

      await McpCatalogLabelModel.syncCatalogLabels(catalog2.id, [
        { key: "category", value: "ai" },
      ]);

      // catalog3 has no labels

      const labelsMap = await McpCatalogLabelModel.getLabelsForCatalogItems([
        catalog1.id,
        catalog2.id,
        catalog3.id,
      ]);

      expect(labelsMap.size).toBe(3);

      const catalog1Labels = labelsMap.get(catalog1.id);
      expect(catalog1Labels).toHaveLength(2);
      expect(catalog1Labels?.[0].key).toBe("category");
      expect(catalog1Labels?.[0].value).toBe("database");
      expect(catalog1Labels?.[1].key).toBe("tier");
      expect(catalog1Labels?.[1].value).toBe("premium");

      const catalog2Labels = labelsMap.get(catalog2.id);
      expect(catalog2Labels).toHaveLength(1);
      expect(catalog2Labels?.[0].key).toBe("category");
      expect(catalog2Labels?.[0].value).toBe("ai");

      const catalog3Labels = labelsMap.get(catalog3.id);
      expect(catalog3Labels).toHaveLength(0);
    });

    test("returns empty map for empty catalog IDs array", async () => {
      const labelsMap = await McpCatalogLabelModel.getLabelsForCatalogItems([]);
      expect(labelsMap.size).toBe(0);
    });
  });

  describe("getAllKeys", () => {
    test("returns keys used by catalog items", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog();

      await McpCatalogLabelModel.syncCatalogLabels(catalog.id, [
        { key: "category", value: "database" },
        { key: "tier", value: "premium" },
      ]);

      const keys = await McpCatalogLabelModel.getAllKeys();
      expect(keys).toContain("category");
      expect(keys).toContain("tier");
    });
  });

  describe("getValuesByKey", () => {
    test("returns values for a specific key", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog1 = await makeInternalMcpCatalog();
      const catalog2 = await makeInternalMcpCatalog();

      await McpCatalogLabelModel.syncCatalogLabels(catalog1.id, [
        { key: "category", value: "database" },
      ]);

      await McpCatalogLabelModel.syncCatalogLabels(catalog2.id, [
        { key: "category", value: "ai" },
      ]);

      const values = await McpCatalogLabelModel.getValuesByKey("category");
      expect(values).toContain("database");
      expect(values).toContain("ai");
    });

    test("returns empty array for nonexistent key", async () => {
      const values =
        await McpCatalogLabelModel.getValuesByKey("nonexistent-key");
      expect(values).toHaveLength(0);
    });
  });

  describe("cross-entity pruning", () => {
    test("does not prune key/value used by catalog item when removed from agent", async ({
      makeAgent,
      makeInternalMcpCatalog,
    }) => {
      const agent = await makeAgent();
      const catalog = await makeInternalMcpCatalog();

      // Assign same key/value to both agent and catalog item
      await AgentLabelModel.syncAgentLabels(agent.id, [
        { key: "shared-key", value: "shared-value", keyId: "", valueId: "" },
      ]);

      await McpCatalogLabelModel.syncCatalogLabels(catalog.id, [
        { key: "shared-key", value: "shared-value" },
      ]);

      // Remove from agent - should NOT prune since catalog still uses it
      await AgentLabelModel.syncAgentLabels(agent.id, []);

      const keys = await AgentLabelModel.getAllKeys();
      const values = await AgentLabelModel.getAllValues();
      expect(keys).toContain("shared-key");
      expect(values).toContain("shared-value");

      // Verify catalog item still has the label
      const catalogLabels = await McpCatalogLabelModel.getLabelsForCatalogItem(
        catalog.id,
      );
      expect(catalogLabels).toHaveLength(1);
      expect(catalogLabels[0].key).toBe("shared-key");
    });

    test("does not prune key/value used by agent when removed from catalog item", async ({
      makeAgent,
      makeInternalMcpCatalog,
    }) => {
      const agent = await makeAgent();
      const catalog = await makeInternalMcpCatalog();

      // Assign same key/value to both
      await AgentLabelModel.syncAgentLabels(agent.id, [
        { key: "shared-key", value: "shared-value", keyId: "", valueId: "" },
      ]);

      await McpCatalogLabelModel.syncCatalogLabels(catalog.id, [
        { key: "shared-key", value: "shared-value" },
      ]);

      // Remove from catalog - should NOT prune since agent still uses it
      await McpCatalogLabelModel.syncCatalogLabels(catalog.id, []);

      const keys = await AgentLabelModel.getAllKeys();
      const values = await AgentLabelModel.getAllValues();
      expect(keys).toContain("shared-key");
      expect(values).toContain("shared-value");
    });

    test("prunes key/value when removed from both agent and catalog item", async ({
      makeAgent,
      makeInternalMcpCatalog,
    }) => {
      const agent = await makeAgent();
      const catalog = await makeInternalMcpCatalog();

      // Assign same key/value to both
      await AgentLabelModel.syncAgentLabels(agent.id, [
        { key: "orphan-key", value: "orphan-value", keyId: "", valueId: "" },
      ]);

      await McpCatalogLabelModel.syncCatalogLabels(catalog.id, [
        { key: "orphan-key", value: "orphan-value" },
      ]);

      // Remove from both
      await AgentLabelModel.syncAgentLabels(agent.id, []);
      await McpCatalogLabelModel.syncCatalogLabels(catalog.id, []);

      const keys = await AgentLabelModel.getAllKeys();
      const values = await AgentLabelModel.getAllValues();
      expect(keys).not.toContain("orphan-key");
      expect(values).not.toContain("orphan-value");
    });
  });
});
