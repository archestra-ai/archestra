import os from "node:os";
import path from "node:path";
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

// The service-account namespace file and the marker file are externally-owned
// storage (kubelet-projected volume / container-local tmp).
const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
  writeFile: writeFileMock,
}));

const readNamespacedPod = vi.hoisted(() => vi.fn());
const loadFromCluster = vi.hoisted(() => vi.fn());
vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: class {
    loadFromCluster = loadFromCluster;
    makeApiClient() {
      return { readNamespacedPod };
    }
  },
  CoreV1Api: class {},
}));

const NAMESPACE_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/namespace";
const MARKER_PATH = path.join(
  os.tmpdir(),
  "archestra-terminations-reported.json",
);

/** In-cluster namespace file present; marker file holds `markers` (or none). */
function primeFs(markers: string[] | null) {
  readFileMock.mockImplementation(async (file: string) => {
    if (file === NAMESPACE_PATH) {
      return "archestra\n";
    }
    if (file === MARKER_PATH && markers !== null) {
      return JSON.stringify(markers);
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
}

function podWithLastState(
  terminated:
    | {
        reason?: string;
        exitCode: number;
        containerID?: string;
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
    writeFileMock.mockResolvedValue(undefined);
  });

  test("reports an OOMKilled previous container as fatal and records a marker", async () => {
    primeFs(null);
    readNamespacedPod.mockResolvedValue(
      podWithLastState({
        reason: "OOMKilled",
        exitCode: 137,
        containerID: "containerd://abc",
      }),
    );

    await reportAbnormalPreviousTermination();

    expect(readNamespacedPod).toHaveBeenCalledWith({
      name: os.hostname(),
      namespace: "archestra",
    });

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
      $exception_fingerprint:
        "container-abnormal-termination/archestra-platform/OOMKilled",
      reason: "OOMKilled",
      exitCode: 137,
    });

    expect(writeFileMock).toHaveBeenCalledWith(
      MARKER_PATH,
      JSON.stringify(["archestra-platform:containerd://abc"]),
    );
  });

  test("does not re-report a termination already recorded in the marker file", async () => {
    // supervisord restarts the backend process without restarting the
    // container, so the same lastState is read again on the next boot.
    primeFs(["archestra-platform:containerd://abc"]);
    readNamespacedPod.mockResolvedValue(
      podWithLastState({
        reason: "OOMKilled",
        exitCode: 137,
        containerID: "containerd://abc",
      }),
    );

    await reportAbnormalPreviousTermination();

    expect(captureExceptionSentry).not.toHaveBeenCalled();
    expect(capturePosthog).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  test("reports a new termination even when an older one is recorded", async () => {
    primeFs(["archestra-platform:containerd://old"]);
    readNamespacedPod.mockResolvedValue(
      podWithLastState({
        reason: "OOMKilled",
        exitCode: 137,
        containerID: "containerd://new",
      }),
    );

    await reportAbnormalPreviousTermination();

    expect(captureExceptionSentry).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledWith(
      MARKER_PATH,
      JSON.stringify([
        "archestra-platform:containerd://old",
        "archestra-platform:containerd://new",
      ]),
    );
  });

  test("reports a non-zero exit without OOM at error level", async () => {
    primeFs(null);
    readNamespacedPod.mockResolvedValue(
      podWithLastState({ reason: "Error", exitCode: 1 }),
    );

    await reportAbnormalPreviousTermination();

    expect(captureExceptionSentry).toHaveBeenCalledTimes(1);
    expect(captureExceptionSentry.mock.calls[0][1].level).toBe("error");
  });

  test("stays silent for a clean previous termination", async () => {
    primeFs(null);
    readNamespacedPod.mockResolvedValue(
      podWithLastState({ reason: "Completed", exitCode: 0 }),
    );

    await reportAbnormalPreviousTermination();

    expect(captureExceptionSentry).not.toHaveBeenCalled();
    expect(capturePosthog).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  test("stays silent when the container never restarted", async () => {
    primeFs(null);
    readNamespacedPod.mockResolvedValue(podWithLastState(undefined));

    await reportAbnormalPreviousTermination();

    expect(captureExceptionSentry).not.toHaveBeenCalled();
  });

  test("does nothing outside Kubernetes (no service-account namespace file)", async () => {
    readFileMock.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    await reportAbnormalPreviousTermination();

    expect(loadFromCluster).not.toHaveBeenCalled();
    expect(readNamespacedPod).not.toHaveBeenCalled();
    expect(captureExceptionSentry).not.toHaveBeenCalled();
  });

  test("swallows Kubernetes API failures without throwing", async () => {
    primeFs(null);
    readNamespacedPod.mockRejectedValue(new Error("forbidden"));

    await expect(reportAbnormalPreviousTermination()).resolves.toBeUndefined();
    expect(captureExceptionSentry).not.toHaveBeenCalled();
  });
});
