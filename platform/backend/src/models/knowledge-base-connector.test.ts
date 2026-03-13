import { describe, expect, test } from "@/test";
import KnowledgeBaseConnectorModel from "./knowledge-base-connector";

describe("KnowledgeBaseConnectorModel", () => {
  describe("findByOrganization", () => {
    test("returns connectors for a given organization", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id, {
        name: "Connector A",
      });
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id, {
        name: "Connector B",
      });

      const results = await KnowledgeBaseConnectorModel.findByOrganization({
        organizationId: org.id,
      });

      expect(results).toHaveLength(2);
      const ids = results.map((r) => r.id);
      expect(ids).toContain(connector1.id);
      expect(ids).toContain(connector2.id);
    });

    test("does not return connectors from other organizations", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org1.id);
      const kb2 = await makeKnowledgeBase(org2.id);
      await makeKnowledgeBaseConnector(kb1.id, org1.id);
      await makeKnowledgeBaseConnector(kb2.id, org2.id);

      const results = await KnowledgeBaseConnectorModel.findByOrganization({
        organizationId: org1.id,
      });

      expect(results).toHaveLength(1);
    });

    test("respects limit parameter", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await makeKnowledgeBaseConnector(kb.id, org.id, { name: "A" });
      await makeKnowledgeBaseConnector(kb.id, org.id, { name: "B" });
      await makeKnowledgeBaseConnector(kb.id, org.id, { name: "C" });

      const results = await KnowledgeBaseConnectorModel.findByOrganization({
        organizationId: org.id,
        limit: 2,
      });

      expect(results).toHaveLength(2);
    });

    test("respects offset parameter", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await makeKnowledgeBaseConnector(kb.id, org.id, { name: "A" });
      await makeKnowledgeBaseConnector(kb.id, org.id, { name: "B" });
      await makeKnowledgeBaseConnector(kb.id, org.id, { name: "C" });

      const all = await KnowledgeBaseConnectorModel.findByOrganization({
        organizationId: org.id,
      });
      const offset = await KnowledgeBaseConnectorModel.findByOrganization({
        organizationId: org.id,
        offset: 1,
      });

      expect(all).toHaveLength(3);
      expect(offset).toHaveLength(2);
    });

    test("returns empty array for organization with no connectors", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const results = await KnowledgeBaseConnectorModel.findByOrganization({
        organizationId: org.id,
      });
      expect(results).toHaveLength(0);
    });
  });

  describe("countByOrganization", () => {
    test("returns the count of connectors for an organization", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await makeKnowledgeBaseConnector(kb.id, org.id);
      await makeKnowledgeBaseConnector(kb.id, org.id);

      const count = await KnowledgeBaseConnectorModel.countByOrganization(
        org.id,
      );

      expect(count).toBe(2);
    });

    test("returns 0 when organization has no connectors", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const count = await KnowledgeBaseConnectorModel.countByOrganization(
        org.id,
      );
      expect(count).toBe(0);
    });

    test("does not count connectors from other organizations", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org1.id);
      const kb2 = await makeKnowledgeBase(org2.id);
      await makeKnowledgeBaseConnector(kb1.id, org1.id);
      await makeKnowledgeBaseConnector(kb2.id, org2.id);
      await makeKnowledgeBaseConnector(kb2.id, org2.id);

      const count = await KnowledgeBaseConnectorModel.countByOrganization(
        org1.id,
      );

      expect(count).toBe(1);
    });
  });

  describe("findByKnowledgeBaseId", () => {
    test("returns connectors assigned to a knowledge base", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const results = await KnowledgeBaseConnectorModel.findByKnowledgeBaseId(
        kb.id,
      );

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(connector.id);
    });

    test("does not return connectors assigned to other knowledge bases", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      await makeKnowledgeBaseConnector(kb1.id, org.id);
      await makeKnowledgeBaseConnector(kb2.id, org.id);

      const results = await KnowledgeBaseConnectorModel.findByKnowledgeBaseId(
        kb1.id,
      );

      expect(results).toHaveLength(1);
    });

    test("returns empty array for knowledge base with no connectors", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);

      const results = await KnowledgeBaseConnectorModel.findByKnowledgeBaseId(
        kb.id,
      );

      expect(results).toHaveLength(0);
    });
  });

  describe("findByKnowledgeBaseIds", () => {
    test("returns connectors with knowledgeBaseId for multiple knowledge bases", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb1.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb2.id, org.id);

      const results = await KnowledgeBaseConnectorModel.findByKnowledgeBaseIds([
        kb1.id,
        kb2.id,
      ]);

      expect(results).toHaveLength(2);
      const result1 = results.find((r) => r.id === connector1.id);
      const result2 = results.find((r) => r.id === connector2.id);
      expect(result1?.knowledgeBaseId).toBe(kb1.id);
      expect(result2?.knowledgeBaseId).toBe(kb2.id);
    });

    test("returns empty array for empty input", async () => {
      const results = await KnowledgeBaseConnectorModel.findByKnowledgeBaseIds(
        [],
      );
      expect(results).toHaveLength(0);
    });

    test("does not return connectors from unspecified knowledge bases", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      await makeKnowledgeBaseConnector(kb1.id, org.id);
      await makeKnowledgeBaseConnector(kb2.id, org.id);

      const results = await KnowledgeBaseConnectorModel.findByKnowledgeBaseIds([
        kb1.id,
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].knowledgeBaseId).toBe(kb1.id);
    });
  });

  describe("findById", () => {
    test("returns a connector by its ID", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        name: "My Connector",
      });

      const result = await KnowledgeBaseConnectorModel.findById(connector.id);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(connector.id);
      expect(result?.name).toBe("My Connector");
      expect(result?.connectorType).toBe("jira");
    });

    test("returns null for non-existent ID", async () => {
      const result = await KnowledgeBaseConnectorModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(result).toBeNull();
    });
  });

  describe("findByIds", () => {
    test("returns connectors matching the given IDs", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id, {
        name: "Connector 1",
      });
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id, {
        name: "Connector 2",
      });

      const results = await KnowledgeBaseConnectorModel.findByIds([
        connector1.id,
        connector2.id,
      ]);

      expect(results).toHaveLength(2);
      const ids = results.map((r) => r.id);
      expect(ids).toContain(connector1.id);
      expect(ids).toContain(connector2.id);
    });

    test("returns empty array for empty input", async () => {
      const results = await KnowledgeBaseConnectorModel.findByIds([]);
      expect(results).toHaveLength(0);
    });

    test("returns only matching connectors and ignores non-existent IDs", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const results = await KnowledgeBaseConnectorModel.findByIds([
        connector.id,
        "00000000-0000-0000-0000-000000000000",
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(connector.id);
    });

    test("does not return connectors not in the ID list", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id, {
        name: "Included",
      });
      await makeKnowledgeBaseConnector(kb.id, org.id, { name: "Excluded" });

      const results = await KnowledgeBaseConnectorModel.findByIds([
        connector1.id,
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Included");
    });

    test("returns connectors across different organizations", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org1.id);
      const kb2 = await makeKnowledgeBase(org2.id);
      const connector1 = await makeKnowledgeBaseConnector(kb1.id, org1.id);
      const connector2 = await makeKnowledgeBaseConnector(kb2.id, org2.id);

      const results = await KnowledgeBaseConnectorModel.findByIds([
        connector1.id,
        connector2.id,
      ]);

      expect(results).toHaveLength(2);
    });
  });

  describe("create", () => {
    test("creates a new connector with required fields", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId: org.id,
        name: "New Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "PROJ",
        },
      });

      expect(connector.id).toBeDefined();
      expect(connector.name).toBe("New Connector");
      expect(connector.connectorType).toBe("jira");
      expect(connector.organizationId).toBe(org.id);
      expect(connector.enabled).toBe(true);
      expect(connector.schedule).toBe("0 */6 * * *");
    });

    test("creates a connector with optional fields", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId: org.id,
        name: "Custom Connector",
        connectorType: "confluence",
        config: {
          type: "confluence",
          confluenceUrl: "https://test.atlassian.net/wiki",
          isCloud: true,
        },
        schedule: "0 0 * * *",
        enabled: false,
      });

      expect(connector.schedule).toBe("0 0 * * *");
      expect(connector.enabled).toBe(false);
      expect(connector.connectorType).toBe("confluence");
    });
  });

  describe("update", () => {
    test("updates a connector's fields", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const updated = await KnowledgeBaseConnectorModel.update(connector.id, {
        name: "Updated Name",
        enabled: false,
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe("Updated Name");
      expect(updated?.enabled).toBe(false);
    });

    test("returns null when updating a non-existent connector", async () => {
      const result = await KnowledgeBaseConnectorModel.update(
        "00000000-0000-0000-0000-000000000000",
        { name: "Does Not Exist" },
      );
      expect(result).toBeNull();
    });

    test("updates lastSyncAt and lastSyncStatus", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const syncTime = new Date();

      const updated = await KnowledgeBaseConnectorModel.update(connector.id, {
        lastSyncAt: syncTime,
        lastSyncStatus: "success",
      });

      expect(updated?.lastSyncAt).toEqual(syncTime);
      expect(updated?.lastSyncStatus).toBe("success");
    });
  });

  describe("findAllEnabled", () => {
    test("returns only enabled connectors", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const enabledConnector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        enabled: true,
      });
      await makeKnowledgeBaseConnector(kb.id, org.id, { enabled: false });

      const results = await KnowledgeBaseConnectorModel.findAllEnabled();

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(enabledConnector.id);
    });

    test("returns empty array when no connectors are enabled", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await makeKnowledgeBaseConnector(kb.id, org.id, { enabled: false });

      const results = await KnowledgeBaseConnectorModel.findAllEnabled();

      expect(results).toHaveLength(0);
    });

    test("returns connectors across all organizations", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org1.id);
      const kb2 = await makeKnowledgeBase(org2.id);
      await makeKnowledgeBaseConnector(kb1.id, org1.id, { enabled: true });
      await makeKnowledgeBaseConnector(kb2.id, org2.id, { enabled: true });

      const results = await KnowledgeBaseConnectorModel.findAllEnabled();

      expect(results).toHaveLength(2);
    });
  });

  describe("delete", () => {
    test("deletes a connector so it is no longer found", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      await KnowledgeBaseConnectorModel.delete(connector.id);

      // Verify connector is gone (PGlite may not return accurate rowCount)
      const found = await KnowledgeBaseConnectorModel.findById(connector.id);
      expect(found).toBeNull();
    });

    test("does not throw when deleting a non-existent connector", async () => {
      // Should not throw; PGlite rowCount behavior may vary
      await KnowledgeBaseConnectorModel.delete(
        "00000000-0000-0000-0000-000000000000",
      );
    });
  });

  describe("assignToKnowledgeBase", () => {
    test("assigns a connector to a knowledge base", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);

      // Create connector directly (without auto-assignment from fixture)
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId: org.id,
        name: "Standalone Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      // Verify not assigned yet
      const beforeIds = await KnowledgeBaseConnectorModel.getKnowledgeBaseIds(
        connector.id,
      );
      expect(beforeIds).toHaveLength(0);

      // Assign
      await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
        connector.id,
        kb.id,
      );

      const afterIds = await KnowledgeBaseConnectorModel.getKnowledgeBaseIds(
        connector.id,
      );
      expect(afterIds).toHaveLength(1);
      expect(afterIds).toContain(kb.id);
    });

    test("calling assignToKnowledgeBase twice does not throw", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId: org.id,
        name: "Duplicate Test",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
        connector.id,
        kb.id,
      );
      // Should not throw on second call
      await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
        connector.id,
        kb.id,
      );

      const ids = await KnowledgeBaseConnectorModel.getKnowledgeBaseIds(
        connector.id,
      );
      // Junction table has no unique constraint, so duplicates may exist
      expect(ids.length).toBeGreaterThanOrEqual(1);
    });

    test("can assign a connector to multiple knowledge bases", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId: org.id,
        name: "Multi-KB Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
        connector.id,
        kb1.id,
      );
      await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
        connector.id,
        kb2.id,
      );

      const ids = await KnowledgeBaseConnectorModel.getKnowledgeBaseIds(
        connector.id,
      );
      expect(ids).toHaveLength(2);
      expect(ids).toContain(kb1.id);
      expect(ids).toContain(kb2.id);
    });
  });

  describe("unassignFromKnowledgeBase", () => {
    test("removes a connector assignment", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId: org.id,
        name: "To Unassign",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
        connector.id,
        kb.id,
      );

      await KnowledgeBaseConnectorModel.unassignFromKnowledgeBase(
        connector.id,
        kb.id,
      );

      // Verify assignment is gone (PGlite may not return accurate rowCount)
      const ids = await KnowledgeBaseConnectorModel.getKnowledgeBaseIds(
        connector.id,
      );
      expect(ids).toHaveLength(0);
    });

    test("does not throw when assignment does not exist", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId: org.id,
        name: "Not Assigned",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      // Should not throw; PGlite rowCount behavior may vary
      await KnowledgeBaseConnectorModel.unassignFromKnowledgeBase(
        connector.id,
        kb.id,
      );
    });
  });

  describe("checkpoint management", () => {
    test("checkpoint can be set and persisted", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const checkpoint = {
        type: "jira" as const,
        lastSyncedAt: "2026-03-10T15:30:00.000Z",
        lastIssueKey: "PROJ-123",
      };

      const updated = await KnowledgeBaseConnectorModel.update(connector.id, {
        checkpoint,
      });

      expect(updated?.checkpoint).toEqual(checkpoint);
    });

    test("checkpoint is reset to null when config is updated with checkpoint: null", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      // Set a checkpoint
      await KnowledgeBaseConnectorModel.update(connector.id, {
        checkpoint: {
          type: "jira",
          lastSyncedAt: "2026-03-10T15:30:00.000Z",
          lastIssueKey: "PROJ-123",
        },
      });

      // Update config + reset checkpoint (as the route handler does)
      const updated = await KnowledgeBaseConnectorModel.update(connector.id, {
        config: {
          type: "jira",
          jiraBaseUrl: "https://new-instance.atlassian.net",
          isCloud: true,
          projectKey: "NEW",
        },
        checkpoint: null,
      });

      expect(updated?.checkpoint).toBeNull();
      expect((updated?.config as Record<string, unknown>).jiraBaseUrl).toBe(
        "https://new-instance.atlassian.net",
      );
    });

    test("checkpoint is preserved when only non-config fields are updated", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const checkpoint = {
        type: "jira" as const,
        lastSyncedAt: "2026-03-10T15:30:00.000Z",
        lastIssueKey: "PROJ-123",
      };

      await KnowledgeBaseConnectorModel.update(connector.id, { checkpoint });

      // Update only name - checkpoint should be preserved
      const updated = await KnowledgeBaseConnectorModel.update(connector.id, {
        name: "Renamed Connector",
      });

      expect(updated?.name).toBe("Renamed Connector");
      expect(updated?.checkpoint).toEqual(checkpoint);
    });

    test("resetCheckpointsByOrganization resets all connectors in the org", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org1.id);
      const kb2 = await makeKnowledgeBase(org2.id);
      const c1 = await makeKnowledgeBaseConnector(kb1.id, org1.id);
      const c2 = await makeKnowledgeBaseConnector(kb2.id, org2.id);

      const checkpoint = {
        type: "jira" as const,
        lastSyncedAt: "2026-03-10T15:30:00.000Z",
      };

      await KnowledgeBaseConnectorModel.update(c1.id, { checkpoint });
      await KnowledgeBaseConnectorModel.update(c2.id, { checkpoint });

      await KnowledgeBaseConnectorModel.resetCheckpointsByOrganization(org1.id);

      const after1 = await KnowledgeBaseConnectorModel.findById(c1.id);
      const after2 = await KnowledgeBaseConnectorModel.findById(c2.id);

      expect(after1?.checkpoint).toBeNull();
      expect(after2?.checkpoint).toEqual(checkpoint);
    });
  });

  describe("getKnowledgeBaseIds", () => {
    test("returns knowledge base IDs for a connector", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const ids = await KnowledgeBaseConnectorModel.getKnowledgeBaseIds(
        connector.id,
      );

      expect(ids).toHaveLength(1);
      expect(ids).toContain(kb.id);
    });

    test("returns empty array for connector with no assignments", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId: org.id,
        name: "Unassigned Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const ids = await KnowledgeBaseConnectorModel.getKnowledgeBaseIds(
        connector.id,
      );

      expect(ids).toHaveLength(0);
    });
  });
});
