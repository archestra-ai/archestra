import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { beforeEach, describe, expect, test } from "@/test";

// Mock in-process scheduler
const mockInProcessSchedule = vi.fn();
const mockInProcessUnschedule = vi.fn();
const mockInProcessSuspend = vi.fn();
const mockInProcessResume = vi.fn();

vi.mock("@/k8s/cron-job/in-process-scheduler", () => ({
  inProcessScheduler: {
    schedule: (...args: unknown[]) => mockInProcessSchedule(...args),
    unschedule: (...args: unknown[]) => mockInProcessUnschedule(...args),
    suspend: (...args: unknown[]) => mockInProcessSuspend(...args),
    resume: (...args: unknown[]) => mockInProcessResume(...args),
  },
}));

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
    Exec: vi.fn(),
    Log: vi.fn(),
  };
});

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      kb: {
        ...actual.default.kb,
        connectorNamespace: "test-connector-namespace",
        connectorImage: "archestra-backend:test",
      },
      orchestrator: {
        ...actual.default.orchestrator,
        kubernetes: {
          namespace: "test-connector-namespace",
          kubeconfig: undefined,
          loadKubeconfigFromCurrentCluster: false,
        },
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
      expect(call.body.metadata.name).toContain("ac-sync");
      expect(call.body.spec.schedule).toBe("0 */6 * * *");
      expect(call.body.spec.concurrencyPolicy).toBe("Forbid");
      expect(call.body.spec.jobTemplate.spec.activeDeadlineSeconds).toBe(3600);
    });

    test("updates an existing CronJob", async () => {
      const manager = await getManager();

      mockReadNamespacedCronJob.mockResolvedValue({
        metadata: { name: "ac-sync-connector-123" },
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

    test("uses connector image from config", async () => {
      const manager = await getManager();

      mockReadNamespacedCronJob.mockRejectedValue({ statusCode: 404 });
      mockCreateNamespacedCronJob.mockResolvedValue({});

      await manager.createOrUpdateCronJob(defaultParams);

      const call = mockCreateNamespacedCronJob.mock.calls[0][0];
      const container =
        call.body.spec.jobTemplate.spec.template.spec.containers[0];
      expect(container.image).toBe("archestra-backend:test");
      expect(container.name).toBe("worker");
      expect(container.command).toEqual(["node", "--enable-source-maps"]);
      expect(container.args).toEqual([
        "dist/entrypoints/connector-sync.mjs",
        "--connector-id=connector-123",
      ]);
      expect(container.workingDir).toBe("/app/backend");
    });

    test("falls back to in-process scheduler when connector image is not configured", async () => {
      const manager = await getManager();
      const { default: mockedConfig } = await import("@/config");
      const original = mockedConfig.kb.connectorImage;
      mockedConfig.kb.connectorImage = "";

      try {
        await manager.createOrUpdateCronJob(defaultParams);

        expect(mockReadNamespacedCronJob).not.toHaveBeenCalled();
        expect(mockCreateNamespacedCronJob).not.toHaveBeenCalled();
        expect(mockInProcessSchedule).toHaveBeenCalledWith(defaultParams);
      } finally {
        mockedConfig.kb.connectorImage = original;
      }
    });

    test("forwards ARCHESTRA_* and DATABASE_URL env vars to CronJob containers", async () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        ARCHESTRA_DATABASE_URL: "postgresql://test:5432/db",
        ARCHESTRA_AUTH_SECRET: "test-secret",
        DATABASE_URL: "postgresql://test:5432/db",
        HOME: "/home/user",
        PATH: "/usr/bin",
        UNRELATED_VAR: "should-not-appear",
      };

      try {
        const manager = await getManager();

        mockReadNamespacedCronJob.mockRejectedValue({ statusCode: 404 });
        mockCreateNamespacedCronJob.mockResolvedValue({});

        await manager.createOrUpdateCronJob(defaultParams);

        const call = mockCreateNamespacedCronJob.mock.calls[0][0];
        const container =
          call.body.spec.jobTemplate.spec.template.spec.containers[0];
        const envNames = container.env.map((e: { name: string }) => e.name);

        expect(envNames).toContain("ARCHESTRA_DATABASE_URL");
        expect(envNames).toContain("ARCHESTRA_AUTH_SECRET");
        expect(envNames).toContain("DATABASE_URL");
        expect(envNames).not.toContain("HOME");
        expect(envNames).not.toContain("PATH");
        expect(envNames).not.toContain("UNRELATED_VAR");
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe("buildConnectorSyncEnv", () => {
    test("includes ARCHESTRA_* env vars", async () => {
      const originalEnv = process.env;
      process.env = {
        ARCHESTRA_FOO: "bar",
        ARCHESTRA_BAZ: "qux",
      };

      try {
        const { buildConnectorSyncEnv } = await import("./cron-job-manager");
        const env = buildConnectorSyncEnv();

        expect(env).toEqual([
          { name: "ARCHESTRA_FOO", value: "bar" },
          { name: "ARCHESTRA_BAZ", value: "qux" },
        ]);
      } finally {
        process.env = originalEnv;
      }
    });

    test("includes DATABASE_URL", async () => {
      const originalEnv = process.env;
      process.env = {
        DATABASE_URL: "postgresql://localhost:5432/test",
      };

      try {
        const { buildConnectorSyncEnv } = await import("./cron-job-manager");
        const env = buildConnectorSyncEnv();

        expect(env).toEqual([
          { name: "DATABASE_URL", value: "postgresql://localhost:5432/test" },
        ]);
      } finally {
        process.env = originalEnv;
      }
    });

    test("excludes non-ARCHESTRA vars other than DATABASE_URL", async () => {
      const originalEnv = process.env;
      process.env = {
        HOME: "/home/user",
        PATH: "/usr/bin",
        NODE_ENV: "test",
        ARCHESTRA_SECRET: "keep-me",
      };

      try {
        const { buildConnectorSyncEnv } = await import("./cron-job-manager");
        const env = buildConnectorSyncEnv();

        expect(env).toHaveLength(1);
        expect(env[0]).toEqual({
          name: "ARCHESTRA_SECRET",
          value: "keep-me",
        });
      } finally {
        process.env = originalEnv;
      }
    });

    test("excludes vars with empty values", async () => {
      const originalEnv = process.env;
      process.env = {
        ARCHESTRA_EMPTY: "",
        ARCHESTRA_PRESENT: "value",
        DATABASE_URL: "",
      };

      try {
        const { buildConnectorSyncEnv } = await import("./cron-job-manager");
        const env = buildConnectorSyncEnv();

        expect(env).toEqual([{ name: "ARCHESTRA_PRESENT", value: "value" }]);
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe("deleteCronJob", () => {
    test("uses in-process unschedule and skips K8s when no image configured", async () => {
      const manager = await getManager();
      const { default: mockedConfig } = await import("@/config");
      const original = mockedConfig.kb.connectorImage;
      mockedConfig.kb.connectorImage = "";

      try {
        await manager.deleteCronJob("connector-123");

        expect(mockInProcessUnschedule).toHaveBeenCalledWith("connector-123");
        expect(mockDeleteNamespacedCronJob).not.toHaveBeenCalled();
      } finally {
        mockedConfig.kb.connectorImage = original;
      }
    });

    test("deletes an existing CronJob", async () => {
      const manager = await getManager();

      mockDeleteNamespacedCronJob.mockResolvedValue({});

      await manager.deleteCronJob("connector-123");

      expect(mockDeleteNamespacedCronJob).toHaveBeenCalledTimes(1);
      expect(mockDeleteNamespacedCronJob).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.stringContaining("ac-sync"),
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
    test("uses in-process suspend when no image configured", async () => {
      const manager = await getManager();
      const { default: mockedConfig } = await import("@/config");
      const original = mockedConfig.kb.connectorImage;
      mockedConfig.kb.connectorImage = "";

      try {
        await manager.suspendCronJob("connector-123");

        expect(mockInProcessSuspend).toHaveBeenCalledWith("connector-123");
        expect(mockPatchNamespacedCronJob).not.toHaveBeenCalled();
      } finally {
        mockedConfig.kb.connectorImage = original;
      }
    });

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
    test("uses in-process resume when no image configured", async () => {
      const manager = await getManager();
      const { default: mockedConfig } = await import("@/config");
      const original = mockedConfig.kb.connectorImage;
      mockedConfig.kb.connectorImage = "";

      try {
        await manager.resumeCronJob("connector-123");

        expect(mockInProcessResume).toHaveBeenCalledWith("connector-123");
        expect(mockPatchNamespacedCronJob).not.toHaveBeenCalled();
      } finally {
        mockedConfig.kb.connectorImage = original;
      }
    });

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

      // deleteCronJob doesn't have the early-return for missing image,
      // so it still hits the uninitialized guard
      await expect(
        cronJobManager.deleteCronJob("connector-123"),
      ).rejects.toThrow("CronJobManager not initialized");
    });
  });
});
