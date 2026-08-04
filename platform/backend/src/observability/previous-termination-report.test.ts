import { beforeEach, describe, expect, test, vi } from "vitest";
import { reportAbnormalPreviousTermination } from "./previous-termination-report";

vi.mock("@/logging");

const captureExceptionSentry = vi.hoisted(() => vi.fn());
vi.mock("@sentry/node", () => ({
  captureException: captureExceptionSentry,
}));

const capturePosthog = vi.hoisted(() => vi.fn());
vi.mock("@/services/error-tracking", () => ({
  posthogErrorTrackingService: { captureException: capturePosthog },
}));

const readNamespacedPod = vi.hoisted(() => vi.fn());
const isK8sConfigured = vi.hoisted(() => vi.fn());
vi.mock("@/k8s/shared", () => ({
  isK8sConfigured,
  loadKubeConfig: vi.fn(() => ({
    kubeConfig: {},
    namespace: "archestra",
  })),
  createK8sClients: vi.fn(() => ({
    coreApi: { readNamespacedPod },
  })),
}));

function podWithLastState(
  terminated:
    | {
        reason?: string;
        exitCode: number;
        startedAt?: string;
        finishedAt?: string;
      }
    | undefined,
) {
  return {
    status: {
      containerStatuses: [
        {
          name: "archestra-platform",
          restartCount: terminated ? 2 : 0,
          lastState: terminated ? { terminated } : {},
        },
      ],
    },
  };
}

describe("reportAbnormalPreviousTermination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isK8sConfigured.mockReturnValue(true);
  });

  test("reports an OOMKilled previous container as fatal", async () => {
    readNamespacedPod.mockResolvedValue(
      podWithLastState({ reason: "OOMKilled", exitCode: 137 }),
    );

    await reportAbnormalPreviousTermination();

    expect(captureExceptionSentry).toHaveBeenCalledTimes(1);
    const [error, options] = captureExceptionSentry.mock.calls[0];
    expect(error.message).toContain("OOMKilled");
    expect(error.message).toContain("exit code 137");
    expect(options.level).toBe("fatal");
    expect(options.tags).toMatchObject({
      container: "archestra-platform",
      reason: "OOMKilled",
      exit_code: "137",
    });

    expect(capturePosthog).toHaveBeenCalledTimes(1);
    expect(capturePosthog.mock.calls[0][0].properties).toMatchObject({
      reason: "OOMKilled",
      exitCode: 137,
      container: "archestra-platform",
    });
  });

  test("reports a non-zero exit without OOM as error level", async () => {
    readNamespacedPod.mockResolvedValue(
      podWithLastState({ reason: "Error", exitCode: 1 }),
    );

    await reportAbnormalPreviousTermination();

    expect(captureExceptionSentry).toHaveBeenCalledTimes(1);
    expect(captureExceptionSentry.mock.calls[0][1].level).toBe("error");
  });

  test("stays silent for a clean previous termination", async () => {
    readNamespacedPod.mockResolvedValue(
      podWithLastState({ reason: "Completed", exitCode: 0 }),
    );

    await reportAbnormalPreviousTermination();

    expect(captureExceptionSentry).not.toHaveBeenCalled();
    expect(capturePosthog).not.toHaveBeenCalled();
  });

  test("stays silent when the container never restarted", async () => {
    readNamespacedPod.mockResolvedValue(podWithLastState(undefined));

    await reportAbnormalPreviousTermination();

    expect(captureExceptionSentry).not.toHaveBeenCalled();
  });

  test("does nothing when the Kubernetes runtime is not configured", async () => {
    isK8sConfigured.mockReturnValue(false);

    await reportAbnormalPreviousTermination();

    expect(readNamespacedPod).not.toHaveBeenCalled();
    expect(captureExceptionSentry).not.toHaveBeenCalled();
  });

  test("swallows Kubernetes API failures without throwing", async () => {
    readNamespacedPod.mockRejectedValue(new Error("forbidden"));

    await expect(reportAbnormalPreviousTermination()).resolves.toBeUndefined();
    expect(captureExceptionSentry).not.toHaveBeenCalled();
  });
});
