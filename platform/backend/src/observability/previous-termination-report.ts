import os from "node:os";
import * as Sentry from "@sentry/node";
import {
  createK8sClients,
  isK8sConfigured,
  loadKubeConfig,
} from "@/k8s/shared";
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
 * Best-effort by design: requires the in-cluster Kubernetes runtime (the pod
 * name is the container hostname), and any failure is logged at debug level
 * and never affects startup.
 */
export async function reportAbnormalPreviousTermination(): Promise<void> {
  if (!isK8sConfigured()) {
    return;
  }

  try {
    const podName = os.hostname();
    const { kubeConfig, namespace } = loadKubeConfig();
    const { coreApi } = createK8sClients(kubeConfig, namespace);
    const pod = await coreApi.readNamespacedPod({
      name: podName,
      namespace,
    });

    for (const status of pod.status?.containerStatuses ?? []) {
      const terminated = status.lastState?.terminated;
      if (!terminated) {
        continue;
      }
      if (terminated.exitCode === 0 && terminated.reason !== "OOMKilled") {
        continue;
      }

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

      Sentry.captureException(error, {
        level: reason === "OOMKilled" ? "fatal" : "error",
        fingerprint: ["container-abnormal-termination", status.name, reason],
        tags: {
          container: status.name,
          reason,
          exit_code: String(terminated.exitCode),
        },
        extra: context,
      });

      posthogErrorTrackingService.captureException({
        error,
        properties: context,
      });
    }
  } catch (error) {
    // Never let boot-time observability interfere with serving traffic.
    logger.debug(
      { err: error },
      "Skipped previous-termination report (pod status unavailable)",
    );
  }
}
