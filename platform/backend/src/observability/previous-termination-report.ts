import { readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as k8s from "@kubernetes/client-node";
import * as Sentry from "@sentry/node";
import logger from "@/logging";
import { posthogErrorTrackingService } from "@/services/error-tracking";

/**
 * Report this pod's previous container termination when it was abnormal.
 *
 * A memory-limit kill (OOMKilled, exit 137) takes the whole container down —
 * the process that could have reported the failure dies with it, so the kill
 * never reaches error tracking and shows up only as a silent RestartCount
 * bump (T-1015: /llm/logs OOM-killed staging pods for weeks unnoticed). On
 * boot, the replacement process reads its own pod's `lastState.terminated`
 * from the Kubernetes API and reports any abnormal termination through the
 * existing error-tracking integrations.
 *
 * Two deliberate design points:
 * - The pod is resolved from the service-account namespace file plus an
 *   in-cluster client — never from the orchestrator's MCP-workload
 *   configuration, which may point at a different namespace or an external
 *   cluster.
 * - Each termination is reported once. supervisord restarts the backend
 *   *process* without restarting the *container*, so the same lastState is
 *   re-read on every such restart; a marker file in container-local tmp
 *   (preserved across process restarts, wiped by a real container restart)
 *   suppresses the duplicates.
 *
 * Best-effort by design: outside Kubernetes the namespace file is absent and
 * this is a no-op; any failure is logged at debug level and never affects
 * startup.
 */
export async function reportAbnormalPreviousTermination(): Promise<void> {
  try {
    const namespace = (
      await readFile(SERVICE_ACCOUNT_NAMESPACE_PATH, "utf8")
    ).trim();

    const kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromCluster();
    const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);

    // The pod name is the container hostname in Kubernetes.
    const podName = os.hostname();
    const pod = await coreApi.readNamespacedPod({
      name: podName,
      namespace,
    });

    const alreadyReported = await readReportedMarkers();
    const newlyReported: string[] = [];

    for (const status of pod.status?.containerStatuses ?? []) {
      const terminated = status.lastState?.terminated;
      if (!terminated) {
        continue;
      }
      if (terminated.exitCode === 0 && terminated.reason !== "OOMKilled") {
        continue;
      }

      const marker = `${status.name}:${
        terminated.containerID ?? String(terminated.finishedAt ?? "unknown")
      }`;
      if (alreadyReported.includes(marker)) {
        continue;
      }
      newlyReported.push(marker);

      const reason = terminated.reason ?? "unknown";
      const error = new Error(
        `Container "${status.name}" in pod "${podName}" restarted after ${reason} (exit code ${terminated.exitCode})`,
      );
      error.name = "ContainerAbnormalTermination";

      const context = {
        podName,
        namespace,
        container: status.name,
        reason,
        exitCode: terminated.exitCode,
        restartCount: status.restartCount,
        startedAt: terminated.startedAt,
        finishedAt: terminated.finishedAt,
      };

      logger.error(
        context,
        "Previous container instance terminated abnormally",
      );

      const fingerprint = [
        "container-abnormal-termination",
        status.name,
        reason,
      ];

      Sentry.captureException(error, {
        level: reason === "OOMKilled" ? "fatal" : "error",
        fingerprint,
        tags: {
          container: status.name,
          reason,
          exit_code: String(terminated.exitCode),
        },
        extra: context,
      });

      posthogErrorTrackingService.captureException({
        error,
        properties: {
          $exception_fingerprint: fingerprint.join("/"),
          ...context,
        },
      });
    }

    if (newlyReported.length > 0) {
      await writeReportedMarkers([...alreadyReported, ...newlyReported]);
    }
  } catch (error) {
    // Never let boot-time observability interfere with serving traffic.
    logger.debug(
      { err: error },
      "Skipped previous-termination report (not in a cluster, or pod status unavailable)",
    );
  }
}

// === Internal helpers

/** Present exactly when this process runs inside a Kubernetes pod. */
const SERVICE_ACCOUNT_NAMESPACE_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

/**
 * Container-local record of terminations already reported by this container
 * instance — preserved across supervisord-level process restarts, wiped by a
 * real container restart.
 */
const REPORTED_MARKER_PATH = path.join(
  os.tmpdir(),
  "archestra-terminations-reported.json",
);

async function readReportedMarkers(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(REPORTED_MARKER_PATH, "utf8"),
    );
    return Array.isArray(parsed)
      ? parsed.filter((m): m is string => typeof m === "string")
      : [];
  } catch {
    return [];
  }
}

async function writeReportedMarkers(markers: string[]): Promise<void> {
  try {
    // Write-then-rename: an interrupted in-place write would leave corrupt
    // JSON, which reads back as "no markers" and re-reports stale kills.
    const tmpPath = `${REPORTED_MARKER_PATH}.tmp`;
    await writeFile(tmpPath, JSON.stringify(markers));
    await rename(tmpPath, REPORTED_MARKER_PATH);
  } catch (error) {
    logger.debug({ err: error }, "Could not persist termination-report marker");
  }
}
