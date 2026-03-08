import { vi } from "vitest";

const mockCronJobManager = vi.hoisted(() => ({
  initialize: vi.fn(),
  createOrUpdateCronJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/k8s/cron-job", () => ({
  cronJobManager: mockCronJobManager,
}));

import { describe, expect, test } from "@/test";
import { reconcileConnectorCronJobs } from "./reconcile-connector-cron-jobs";

describe("reconcileConnectorCronJobs", () => {
  test("reconciles CronJobs for enabled connectors", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      enabled: true,
      schedule: "0 */6 * * *",
    });

    await reconcileConnectorCronJobs();

    expect(mockCronJobManager.initialize).toHaveBeenCalled();
    expect(mockCronJobManager.createOrUpdateCronJob).toHaveBeenCalledWith({
      connectorId: connector.id,
      schedule: "0 */6 * * *",
    });
  });

  test("skips when CronJobManager not available", async () => {
    mockCronJobManager.initialize.mockImplementationOnce(() => {
      throw new Error("K8s not available");
    });

    await reconcileConnectorCronJobs();

    expect(mockCronJobManager.createOrUpdateCronJob).not.toHaveBeenCalled();
  });

  test("does nothing when no enabled connectors exist", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    // Create a connector that is NOT enabled
    await makeKnowledgeBaseConnector(kb.id, org.id, {
      enabled: false,
    });

    await reconcileConnectorCronJobs();

    expect(mockCronJobManager.createOrUpdateCronJob).not.toHaveBeenCalled();
  });

  test("continues reconciling when individual connector CronJob creation fails", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    await makeKnowledgeBaseConnector(kb.id, org.id, {
      enabled: true,
      schedule: "0 */6 * * *",
    });
    await makeKnowledgeBaseConnector(kb.id, org.id, {
      enabled: true,
      schedule: "0 0 * * *",
    });

    // First call fails, second succeeds
    mockCronJobManager.createOrUpdateCronJob
      .mockRejectedValueOnce(new Error("K8s error"))
      .mockResolvedValueOnce(undefined);

    await reconcileConnectorCronJobs();

    expect(mockCronJobManager.createOrUpdateCronJob).toHaveBeenCalledTimes(2);
  });
});
