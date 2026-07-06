import { describe, expect, test } from "@/test";
import ConnectorRunModel from "./connector-run";
import TaskModel from "./task";

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

  describe("deleteByConnector", () => {
    test("deletes all runs for a connector", async ({
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

      await ConnectorRunModel.deleteByConnector(connector.id);

      const count = await ConnectorRunModel.countByConnector(connector.id);
      expect(count).toBe(0);
    });

    test("does not delete runs from other connectors", async ({
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

      await ConnectorRunModel.deleteByConnector(connector1.id);

      const count1 = await ConnectorRunModel.countByConnector(connector1.id);
      const count2 = await ConnectorRunModel.countByConnector(connector2.id);
      expect(count1).toBe(0);
      expect(count2).toBe(2);
    });

    test("returns 0 when connector has no runs", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const count = await ConnectorRunModel.deleteByConnector(connector.id);

      expect(count).toBe(0);
    });
  });

  describe("sumDocsIngestedByConnector", () => {
    test("returns sum of documentsIngested for a connector", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "success",
        startedAt: new Date(),
        documentsIngested: 10,
      });
      await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "success",
        startedAt: new Date(),
        documentsIngested: 20,
      });

      const result = await ConnectorRunModel.sumDocsIngestedByConnector(
        connector.id,
      );

      expect(result).toBe(30);
    });

    test("returns 0 for connector with no runs", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const result = await ConnectorRunModel.sumDocsIngestedByConnector(
        connector.id,
      );

      expect(result).toBe(0);
    });

    test("does not include runs from other connectors", async ({
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
        documentsIngested: 10,
      });
      await ConnectorRunModel.create({
        connectorId: connector2.id,
        status: "success",
        startedAt: new Date(),
        documentsIngested: 20,
      });

      const result = await ConnectorRunModel.sumDocsIngestedByConnector(
        connector1.id,
      );

      expect(result).toBe(10);
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

  const PAST_LEASE = () => new Date(Date.now() - 60_000);
  const FUTURE_LEASE = () => new Date(Date.now() + 60_000);

  describe("claim", () => {
    test("claims a run with a lease when no run is active", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const result = await ConnectorRunModel.claim({
        connectorId: connector.id,
        owner: "worker-1",
        leaseTtlSeconds: 300,
      });

      expect(result.outcome).toBe("claimed");
      if (result.outcome !== "claimed") return;
      expect(result.run.status).toBe("running");
      expect(result.run.leaseOwner).toBe("worker-1");
      expect(result.run.leaseExpiresAt).not.toBeNull();
      expect(result.run.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    });

    test("returns busy when a live-lease run already holds the slot", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await makeConnectorRun(connector.id, {
        status: "running",
        leaseExpiresAt: FUTURE_LEASE(),
      });

      const result = await ConnectorRunModel.claim({
        connectorId: connector.id,
        owner: "worker-2",
        leaseTtlSeconds: 300,
      });

      expect(result.outcome).toBe("busy");
    });

    test("is busy even when the existing run's lease has expired (reaper reclaims, not claim)", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const stale = await makeConnectorRun(connector.id, {
        status: "running",
        leaseExpiresAt: PAST_LEASE(),
      });

      // claim() is a pure insert-or-skip: an expired-lease run still occupies the
      // single-flight slot, so a new claim is busy. The reaper is the sole
      // reclaimer — it frees the slot on its next pass, and claim never fences a
      // run out from under a possibly-live owner.
      const result = await ConnectorRunModel.claim({
        connectorId: connector.id,
        owner: "worker-2",
        leaseTtlSeconds: 300,
      });

      expect(result.outcome).toBe("busy");
      const old = await ConnectorRunModel.findById(stale.id);
      expect(old?.status).toBe("running");
      expect(old?.leaseEpoch).toBe(0);
    });
  });

  describe("updateIfOwned", () => {
    test("updates when the epoch matches", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const run = await makeConnectorRun(connector.id, { status: "running" });

      const result = await ConnectorRunModel.updateIfOwned({
        runId: run.id,
        epoch: 0,
        data: { documentsProcessed: 7 },
      });

      expect(result?.documentsProcessed).toBe(7);
    });

    test("no-ops (returns null) when the epoch is stale — fenced", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const run = await makeConnectorRun(connector.id, {
        status: "running",
        leaseEpoch: 1,
        documentsProcessed: 3,
      });

      const result = await ConnectorRunModel.updateIfOwned({
        runId: run.id,
        epoch: 0, // stale
        data: { documentsProcessed: 99 },
      });

      expect(result).toBeNull();
      const after = await ConnectorRunModel.findById(run.id);
      expect(after?.documentsProcessed).toBe(3);
    });
  });

  describe("renewLease", () => {
    test("extends the lease when owner + epoch match", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const run = await makeConnectorRun(connector.id, {
        status: "running",
        leaseOwner: "worker-1",
        leaseExpiresAt: PAST_LEASE(),
      });

      const held = await ConnectorRunModel.renewLease({
        runId: run.id,
        owner: "worker-1",
        epoch: 0,
        leaseTtlSeconds: 300,
      });

      expect(held).toBe(true);
      const after = await ConnectorRunModel.findById(run.id);
      expect(after?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    });

    test("returns false when fenced (epoch bumped)", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const run = await makeConnectorRun(connector.id, {
        status: "running",
        leaseOwner: "worker-1",
        leaseEpoch: 1,
      });

      const held = await ConnectorRunModel.renewLease({
        runId: run.id,
        owner: "worker-1",
        epoch: 0, // stale
        leaseTtlSeconds: 300,
      });

      expect(held).toBe(false);
    });
  });

  describe("reapExpiredRuns", () => {
    test("reclaims an expired-lease run as partial and bumps epoch", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const run = await makeConnectorRun(connector.id, {
        status: "running",
        leaseExpiresAt: PAST_LEASE(),
      });

      const reaped = await ConnectorRunModel.reapExpiredRuns();

      expect(reaped.map((r) => r.id)).toContain(run.id);
      const after = await ConnectorRunModel.findById(run.id);
      expect(after?.status).toBe("partial");
      expect(after?.leaseEpoch).toBe(1);
      expect(after?.completedAt).not.toBeNull();
    });

    test("leaves a live-lease run untouched (healthy, incl. mid-drain)", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const run = await makeConnectorRun(connector.id, {
        status: "running",
        leaseExpiresAt: FUTURE_LEASE(),
      });

      const reaped = await ConnectorRunModel.reapExpiredRuns();

      expect(reaped.map((r) => r.id)).not.toContain(run.id);
      const after = await ConnectorRunModel.findById(run.id);
      expect(after?.status).toBe("running");
    });

    test("does not reap an expired-lease run that still has embedding work queued", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const run = await makeConnectorRun(connector.id, {
        status: "running",
        leaseExpiresAt: PAST_LEASE(),
      });
      // During drain the lease is no longer renewed; a pending batch_embedding
      // task is the liveness signal, so this run is draining (even if queued
      // behind a backlog), not orphaned, and must not be reaped.
      await TaskModel.create({
        taskType: "batch_embedding",
        payload: { connectorRunId: run.id, documentIds: ["doc-1"] },
        maxAttempts: 5,
      });

      const reaped = await ConnectorRunModel.reapExpiredRuns();

      expect(reaped.map((r) => r.id)).not.toContain(run.id);
      const after = await ConnectorRunModel.findById(run.id);
      expect(after?.status).toBe("running");
    });
  });

  describe("completeBatch", () => {
    test("is a no-op for a superseded run (does not touch status or counters)", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      // Create a run that looks like it was superseded (with batches remaining)
      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt: new Date(),
        totalBatches: 1,
        completedBatches: 0,
      });

      // Simulate interruption by a newer sync run
      await ConnectorRunModel.update(run.id, {
        status: "superseded",
        error: "A newer sync run replaced this one before it finished.",
      });

      // A late batch_embedding task belonging to the superseded run completes
      const result = await ConnectorRunModel.completeBatch(run.id);

      // Matches nothing running → no-op: neither status nor counters change,
      // so the dead run never resurrects or drifts.
      expect(result).toBeNull();
      const after = await ConnectorRunModel.findById(run.id);
      expect(after?.status).toBe("superseded");
      expect(after?.completedBatches).toBe(0);
    });

    test("does not transition status when totalBatches is 0", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      // totalBatches defaults to 0 — not yet set by sync loop
      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt: new Date(),
        totalBatches: 0,
        completedBatches: 0,
      });

      const result = await ConnectorRunModel.completeBatch(run.id);

      // Should stay "running" — totalBatches hasn't been set yet
      expect(result?.status).toBe("running");
      expect(result?.completedBatches).toBe(1);
      expect(result?.completedAt).toBeNull();
    });

    test("transitions running run to success when last batch completes", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt: new Date(),
        totalBatches: 1,
        completedBatches: 0,
      });

      const result = await ConnectorRunModel.completeBatch(run.id);

      expect(result?.status).toBe("success");
      expect(result?.completedBatches).toBe(1);
      expect(result?.completedAt).not.toBeNull();
    });
  });

  describe("finalizeBatchesIfComplete", () => {
    test("transitions to success when completedBatches >= totalBatches > 0", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt: new Date(),
        totalBatches: 2,
        completedBatches: 2,
      });

      const result = await ConnectorRunModel.finalizeBatchesIfComplete(run.id);

      expect(result?.status).toBe("success");
      expect(result?.completedAt).not.toBeNull();
    });

    test("transitions to completed_with_errors when there are item errors", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt: new Date(),
        totalBatches: 2,
        completedBatches: 2,
        itemErrors: 3,
      });

      const result = await ConnectorRunModel.finalizeBatchesIfComplete(run.id);

      expect(result?.status).toBe("completed_with_errors");
      expect(result?.completedAt).not.toBeNull();
    });

    test("stays running when completedBatches < totalBatches", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt: new Date(),
        totalBatches: 3,
        completedBatches: 1,
      });

      const result = await ConnectorRunModel.finalizeBatchesIfComplete(run.id);

      expect(result?.status).toBe("running");
      expect(result?.completedAt).toBeNull();
    });

    test("preserves non-running statuses", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt: new Date(),
        totalBatches: 1,
        completedBatches: 1,
      });

      // Simulate the run being failed/superseded
      await ConnectorRunModel.update(run.id, {
        status: "failed",
        error: "Superseded by new sync run",
      });

      const result = await ConnectorRunModel.finalizeBatchesIfComplete(run.id);

      expect(result?.status).toBe("failed");
    });
  });
});
