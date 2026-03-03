import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { beforeEach, describe, expect, test } from "@/test";

// Mock @kubernetes/client-node
const mockReadNamespacedCronJob = vi.fn();
const mockCreateNamespacedCronJob = vi.fn();
const mockReplaceNamespacedCronJob = vi.fn();
const mockDeleteNamespacedCronJob = vi.fn();
const mockPatchNamespacedCronJob = vi.fn();

vi.mock("@kubernetes/client-node", () => {
  class MockKubeConfig {
    clusters = [{ name: "test", server: "https://test" }];
    contexts = [{ name: "test" }];
    users = [{ name: "test" }];
    loadFromDefault() {}
    loadFromCluster() {}
    loadFromFile() {}
    loadFromString() {}
    makeApiClient() {
      return {
        readNamespacedCronJob: mockReadNamespacedCronJob,
        createNamespacedCronJob: mockCreateNamespacedCronJob,
        replaceNamespacedCronJob: mockReplaceNamespacedCronJob,
        deleteNamespacedCronJob: mockDeleteNamespacedCronJob,
        patchNamespacedCronJob: mockPatchNamespacedCronJob,
      };
    }
  }
  return {
    KubeConfig: MockKubeConfig,
    CoreV1Api: vi.fn(),
    AppsV1Api: vi.fn(),
    BatchV1Api: vi.fn(),
    Attach: vi.fn(),
    Log: vi.fn(),
  };
});

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      orchestrator: {
        kubernetes: {
          namespace: "test-connector-namespace",
          kubeconfig: undefined,
          loadKubeconfigFromCurrentCluster: false,
        },
        connectorNamespace: "test-connector-namespace",
      },
    },
  };
});

describe("CronJobManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function getManager() {
    const { cronJobManager } = await import("./cron-job-manager");
    cronJobManager.initialize();
    return cronJobManager;
  }

  const defaultParams = {
    connectorId: "connector-123",
    schedule: "0 */6 * * *",
    backendUrl: "http://localhost:9000",
    hmacSecret: "test-hmac-secret",
  };

  describe("createOrUpdateCronJob", () => {
    test("creates a new CronJob when one does not exist", async () => {
      const manager = await getManager();

      mockReadNamespacedCronJob.mockRejectedValue({ statusCode: 404 });
      mockCreateNamespacedCronJob.mockResolvedValue({});

      await manager.createOrUpdateCronJob(defaultParams);

      expect(mockCreateNamespacedCronJob).toHaveBeenCalledTimes(1);
      const call = mockCreateNamespacedCronJob.mock.calls[0][0];
      expect(call.namespace).toBe("test-connector-namespace");
      expect(call.body.metadata.name).toContain("archestra-connector");
      expect(call.body.spec.schedule).toBe("0 */6 * * *");
      expect(call.body.spec.concurrencyPolicy).toBe("Forbid");
      expect(call.body.spec.jobTemplate.spec.activeDeadlineSeconds).toBe(3600);
    });

    test("updates an existing CronJob", async () => {
      const manager = await getManager();

      mockReadNamespacedCronJob.mockResolvedValue({
        metadata: { name: "archestra-connector-connector-123" },
      });
      mockReplaceNamespacedCronJob.mockResolvedValue({});

      await manager.createOrUpdateCronJob(defaultParams);

      expect(mockReplaceNamespacedCronJob).toHaveBeenCalledTimes(1);
      expect(mockCreateNamespacedCronJob).not.toHaveBeenCalled();
    });

    test("propagates non-404 errors from read", async () => {
      const manager = await getManager();

      mockReadNamespacedCronJob.mockRejectedValue(new Error("K8s API error"));

      await expect(
        manager.createOrUpdateCronJob(defaultParams),
      ).rejects.toThrow("K8s API error");
    });

    test("includes correct labels in CronJob metadata", async () => {
      const manager = await getManager();

      mockReadNamespacedCronJob.mockRejectedValue({ statusCode: 404 });
      mockCreateNamespacedCronJob.mockResolvedValue({});

      await manager.createOrUpdateCronJob(defaultParams);

      const call = mockCreateNamespacedCronJob.mock.calls[0][0];
      expect(call.body.metadata.labels).toEqual({
        app: "archestra-connector",
        "connector-id": expect.any(String),
      });
    });

    test("uses curlimages/curl container image", async () => {
      const manager = await getManager();

      mockReadNamespacedCronJob.mockRejectedValue({ statusCode: 404 });
      mockCreateNamespacedCronJob.mockResolvedValue({});

      await manager.createOrUpdateCronJob(defaultParams);

      const call = mockCreateNamespacedCronJob.mock.calls[0][0];
      const container =
        call.body.spec.jobTemplate.spec.template.spec.containers[0];
      expect(container.image).toBe("curlimages/curl:latest");
      expect(container.name).toBe("worker");
    });
  });

  describe("deleteCronJob", () => {
    test("deletes an existing CronJob", async () => {
      const manager = await getManager();

      mockDeleteNamespacedCronJob.mockResolvedValue({});

      await manager.deleteCronJob("connector-123");

      expect(mockDeleteNamespacedCronJob).toHaveBeenCalledTimes(1);
      expect(mockDeleteNamespacedCronJob).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.stringContaining("archestra-connector"),
          namespace: "test-connector-namespace",
        }),
      );
    });

    test("does not throw when CronJob does not exist", async () => {
      const manager = await getManager();

      mockDeleteNamespacedCronJob.mockRejectedValue({ statusCode: 404 });

      await expect(
        manager.deleteCronJob("connector-123"),
      ).resolves.toBeUndefined();
    });

    test("propagates non-404 errors", async () => {
      const manager = await getManager();

      mockDeleteNamespacedCronJob.mockRejectedValue(new Error("K8s API error"));

      await expect(manager.deleteCronJob("connector-123")).rejects.toThrow(
        "K8s API error",
      );
    });
  });

  describe("suspendCronJob", () => {
    test("patches CronJob with suspend=true", async () => {
      const manager = await getManager();

      mockPatchNamespacedCronJob.mockResolvedValue({});

      await manager.suspendCronJob("connector-123");

      expect(mockPatchNamespacedCronJob).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { spec: { suspend: true } },
          namespace: "test-connector-namespace",
        }),
      );
    });
  });

  describe("resumeCronJob", () => {
    test("patches CronJob with suspend=false", async () => {
      const manager = await getManager();

      mockPatchNamespacedCronJob.mockResolvedValue({});

      await manager.resumeCronJob("connector-123");

      expect(mockPatchNamespacedCronJob).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { spec: { suspend: false } },
          namespace: "test-connector-namespace",
        }),
      );
    });
  });

  describe("getCronJobStatus", () => {
    test("returns status for existing CronJob", async () => {
      const manager = await getManager();

      const lastSchedule = new Date("2026-03-01T12:00:00Z");
      mockReadNamespacedCronJob.mockResolvedValue({
        status: {
          lastScheduleTime: lastSchedule.toISOString(),
          active: [{ name: "job-1" }],
        },
        spec: {
          suspend: false,
        },
      });

      const status = await manager.getCronJobStatus("connector-123");

      expect(status).toEqual({
        lastScheduleTime: expect.any(Date),
        active: 1,
        suspended: false,
      });
    });

    test("returns null when CronJob does not exist", async () => {
      const manager = await getManager();

      mockReadNamespacedCronJob.mockRejectedValue({ statusCode: 404 });

      const status = await manager.getCronJobStatus("connector-123");

      expect(status).toBeNull();
    });

    test("returns suspended=true when CronJob is suspended", async () => {
      const manager = await getManager();

      mockReadNamespacedCronJob.mockResolvedValue({
        status: {
          active: [],
        },
        spec: {
          suspend: true,
        },
      });

      const status = await manager.getCronJobStatus("connector-123");

      expect(status).toEqual({
        lastScheduleTime: undefined,
        active: 0,
        suspended: true,
      });
    });

    test("propagates non-404 errors", async () => {
      const manager = await getManager();

      mockReadNamespacedCronJob.mockRejectedValue(new Error("K8s API error"));

      await expect(manager.getCronJobStatus("connector-123")).rejects.toThrow(
        "K8s API error",
      );
    });
  });

  describe("initialization", () => {
    test("throws when methods called before initialize", async () => {
      vi.resetModules();
      const { cronJobManager } = await import("./cron-job-manager");

      await expect(
        cronJobManager.createOrUpdateCronJob(defaultParams),
      ).rejects.toThrow("CronJobManager not initialized");
    });
  });
});
