import { vi } from "vitest";

const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue("task-id"));
vi.mock("@/task-queue", () => ({
  taskQueueService: { enqueue: mockEnqueue },
}));

import {
  ConnectorRunModel,
  KnowledgeBaseConnectorModel,
  TaskModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { handleCheckDueConnectors } from "./check-due-connectors-handler";

const PAST = () => new Date(Date.now() - 120_000);

describe("handleCheckDueConnectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("does nothing when no connectors are enabled", async () => {
    await handleCheckDueConnectors();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("skips connectors without a schedule", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    // Empty schedule means "no cron" — the column is NOT NULL, so "" is the
    // real-world representation of an unscheduled connector.
    await makeKnowledgeBaseConnector(kb.id, org.id, {
      schedule: "",
      enabled: true,
    });

    await handleCheckDueConnectors();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("enqueues connector sync when cron is due", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      schedule: "* * * * *",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncAt: PAST(),
    });

    await handleCheckDueConnectors();

    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "connector_sync",
      payload: { connectorId: connector.id },
    });
  });

  test("does not enqueue when a pending/processing task already exists", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      schedule: "* * * * *",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncAt: PAST(),
    });
    await TaskModel.create({
      taskType: "connector_sync",
      payload: { connectorId: connector.id },
      status: "pending",
    });

    await handleCheckDueConnectors();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("continues processing other connectors when one fails", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const bad = await makeKnowledgeBaseConnector(kb.id, org.id, {
      schedule: "INVALID_CRON",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(bad.id, { lastSyncAt: PAST() });
    const good = await makeKnowledgeBaseConnector(kb.id, org.id, {
      schedule: "* * * * *",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(good.id, { lastSyncAt: PAST() });

    await handleCheckDueConnectors();

    // The good connector is still enqueued despite the bad one throwing.
    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "connector_sync",
      payload: { connectorId: good.id },
    });
  });

  test("resets orphaned running status to failed when no task or run exists", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      enabled: false,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncStatus: "running",
    });

    await handleCheckDueConnectors();

    const updated = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(updated?.lastSyncStatus).toBe("failed");
    expect(updated?.lastSyncError).toBe("Sync task was lost");
  });

  test("does not reset running status when a pending task exists", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      enabled: false,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncStatus: "running",
    });
    await TaskModel.create({
      taskType: "connector_sync",
      payload: { connectorId: connector.id },
      status: "pending",
    });

    await handleCheckDueConnectors();

    const updated = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(updated?.lastSyncStatus).toBe("running");
  });

  test("does not reset running status when an active run exists", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      enabled: false,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncStatus: "running",
    });
    await ConnectorRunModel.create({
      connectorId: connector.id,
      status: "running",
      startedAt: new Date(),
    });

    await handleCheckDueConnectors();

    const updated = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(updated?.lastSyncStatus).toBe("running");
  });
});
