import { describe, expect, test } from "@/test";
import ConnectorRunModel from "./connector-run";

describe("ConnectorRunModel", () => {
  describe("findByConnector", () => {
    test("returns runs for a given connector ordered by startedAt desc", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const run1 = await makeConnectorRun(connector.id, {
        startedAt: new Date("2024-01-01T00:00:00Z"),
      });
      const run2 = await makeConnectorRun(connector.id, {
        startedAt: new Date("2024-01-02T00:00:00Z"),
      });
      const run3 = await makeConnectorRun(connector.id, {
        startedAt: new Date("2024-01-03T00:00:00Z"),
      });

      const results = await ConnectorRunModel.findByConnector({
        connectorId: connector.id,
      });

      expect(results).toHaveLength(3);
      // Most recent first
      expect(results[0].id).toBe(run3.id);
      expect(results[1].id).toBe(run2.id);
      expect(results[2].id).toBe(run1.id);
    });

    test("does not return runs from other connectors", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id);
      await makeConnectorRun(connector1.id);
      await makeConnectorRun(connector2.id);

      const results = await ConnectorRunModel.findByConnector({
        connectorId: connector1.id,
      });

      expect(results).toHaveLength(1);
    });

    test("respects limit parameter", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await makeConnectorRun(connector.id);
      await makeConnectorRun(connector.id);
      await makeConnectorRun(connector.id);

      const results = await ConnectorRunModel.findByConnector({
        connectorId: connector.id,
        limit: 2,
      });

      expect(results).toHaveLength(2);
    });

    test("respects offset parameter", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await makeConnectorRun(connector.id);
      await makeConnectorRun(connector.id);
      await makeConnectorRun(connector.id);

      const results = await ConnectorRunModel.findByConnector({
        connectorId: connector.id,
        offset: 1,
      });

      expect(results).toHaveLength(2);
    });

    test("returns empty array for connector with no runs", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const results = await ConnectorRunModel.findByConnector({
        connectorId: connector.id,
      });

      expect(results).toHaveLength(0);
    });
  });

  describe("countByConnector", () => {
    test("returns the count of runs for a connector", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await makeConnectorRun(connector.id);
      await makeConnectorRun(connector.id);
      await makeConnectorRun(connector.id);

      const count = await ConnectorRunModel.countByConnector(connector.id);

      expect(count).toBe(3);
    });

    test("returns 0 when connector has no runs", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const count = await ConnectorRunModel.countByConnector(connector.id);

      expect(count).toBe(0);
    });

    test("does not count runs from other connectors", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id);
      await makeConnectorRun(connector1.id);
      await makeConnectorRun(connector2.id);
      await makeConnectorRun(connector2.id);

      const count = await ConnectorRunModel.countByConnector(connector1.id);

      expect(count).toBe(1);
    });
  });

  describe("findById", () => {
    test("returns a run by its ID", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const run = await makeConnectorRun(connector.id, { status: "running" });

      const result = await ConnectorRunModel.findById(run.id);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(run.id);
      expect(result?.connectorId).toBe(connector.id);
      expect(result?.status).toBe("running");
    });

    test("returns null for non-existent ID", async () => {
      const result = await ConnectorRunModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(result).toBeNull();
    });
  });

  describe("create", () => {
    test("creates a run with required fields", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const startTime = new Date();

      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt: startTime,
      });

      expect(run.id).toBeDefined();
      expect(run.connectorId).toBe(connector.id);
      expect(run.status).toBe("running");
      expect(run.startedAt).toEqual(startTime);
      expect(run.completedAt).toBeNull();
      expect(run.documentsProcessed).toBe(0);
      expect(run.documentsIngested).toBe(0);
      expect(run.error).toBeNull();
    });

    test("creates a run with optional fields", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const startTime = new Date("2024-01-01T00:00:00Z");
      const endTime = new Date("2024-01-01T01:00:00Z");

      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "success",
        startedAt: startTime,
        completedAt: endTime,
        documentsProcessed: 100,
        documentsIngested: 95,
        error: null,
      });

      expect(run.status).toBe("success");
      expect(run.completedAt).toEqual(endTime);
      expect(run.documentsProcessed).toBe(100);
      expect(run.documentsIngested).toBe(95);
    });
  });

  describe("update", () => {
    test("updates a run's fields", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const run = await makeConnectorRun(connector.id);
      const completedAt = new Date();

      const updated = await ConnectorRunModel.update(run.id, {
        status: "success",
        completedAt,
        documentsProcessed: 50,
        documentsIngested: 45,
      });

      expect(updated).not.toBeNull();
      expect(updated?.status).toBe("success");
      expect(updated?.completedAt).toEqual(completedAt);
      expect(updated?.documentsProcessed).toBe(50);
      expect(updated?.documentsIngested).toBe(45);
    });

    test("returns null when updating a non-existent run", async () => {
      const result = await ConnectorRunModel.update(
        "00000000-0000-0000-0000-000000000000",
        { status: "failed" },
      );
      expect(result).toBeNull();
    });

    test("updates error field on failure", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const run = await makeConnectorRun(connector.id);

      const updated = await ConnectorRunModel.update(run.id, {
        status: "failed",
        error: "Connection timeout",
      });

      expect(updated?.status).toBe("failed");
      expect(updated?.error).toBe("Connection timeout");
    });
  });

  describe("hasActiveRun", () => {
    test("returns true when connector has a running run", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await makeConnectorRun(connector.id, { status: "running" });

      const result = await ConnectorRunModel.hasActiveRun(connector.id);

      expect(result).toBe(true);
    });

    test("returns false when connector has no running runs", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await makeConnectorRun(connector.id, { status: "success" });
      await makeConnectorRun(connector.id, { status: "failed" });

      const result = await ConnectorRunModel.hasActiveRun(connector.id);

      expect(result).toBe(false);
    });

    test("returns false when connector has no runs", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const result = await ConnectorRunModel.hasActiveRun(connector.id);

      expect(result).toBe(false);
    });

    test("does not consider runs from other connectors", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id);
      await makeConnectorRun(connector2.id, { status: "running" });

      const result = await ConnectorRunModel.hasActiveRun(connector1.id);

      expect(result).toBe(false);
    });
  });

  describe("sumDocsIngestedByKnowledgeBaseIds", () => {
    test("returns sum of documentsIngested per knowledge base", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb1.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb2.id, org.id);

      await ConnectorRunModel.create({
        connectorId: connector1.id,
        status: "success",
        startedAt: new Date(),
        documentsIngested: 10,
      });
      await ConnectorRunModel.create({
        connectorId: connector1.id,
        status: "success",
        startedAt: new Date(),
        documentsIngested: 20,
      });
      await ConnectorRunModel.create({
        connectorId: connector2.id,
        status: "success",
        startedAt: new Date(),
        documentsIngested: 5,
      });

      const result = await ConnectorRunModel.sumDocsIngestedByKnowledgeBaseIds([
        kb1.id,
        kb2.id,
      ]);

      expect(result).toBeInstanceOf(Map);
      expect(result.get(kb1.id)).toBe(30);
      expect(result.get(kb2.id)).toBe(5);
    });

    test("returns empty map for empty input", async () => {
      const result = await ConnectorRunModel.sumDocsIngestedByKnowledgeBaseIds(
        [],
      );
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    test("returns 0 for knowledge bases with null documentsIngested", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      // Create a run without documentsIngested (defaults to null)
      await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt: new Date(),
      });

      const result = await ConnectorRunModel.sumDocsIngestedByKnowledgeBaseIds([
        kb.id,
      ]);

      expect(result.get(kb.id)).toBe(0);
    });

    test("does not include knowledge bases not in the input", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb1.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb2.id, org.id);

      await ConnectorRunModel.create({
        connectorId: connector1.id,
        status: "success",
        startedAt: new Date(),
        documentsIngested: 10,
      });
      await ConnectorRunModel.create({
        connectorId: connector2.id,
        status: "success",
        startedAt: new Date(),
        documentsIngested: 20,
      });

      const result = await ConnectorRunModel.sumDocsIngestedByKnowledgeBaseIds([
        kb1.id,
      ]);

      expect(result.get(kb1.id)).toBe(10);
      expect(result.has(kb2.id)).toBe(false);
    });

    test("aggregates across multiple connectors assigned to same knowledge base", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id);

      await ConnectorRunModel.create({
        connectorId: connector1.id,
        status: "success",
        startedAt: new Date(),
        documentsIngested: 15,
      });
      await ConnectorRunModel.create({
        connectorId: connector2.id,
        status: "success",
        startedAt: new Date(),
        documentsIngested: 25,
      });

      const result = await ConnectorRunModel.sumDocsIngestedByKnowledgeBaseIds([
        kb.id,
      ]);

      expect(result.get(kb.id)).toBe(40);
    });
  });
});
