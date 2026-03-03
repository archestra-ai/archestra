import type * as k8s from "@kubernetes/client-node";
import {
  createK8sClients,
  type K8sClients,
  loadKubeConfig,
} from "@/k8s/shared";
import logger from "@/logging";

const CRONJOB_NAME_PREFIX = "archestra-connector";
const CONTAINER_IMAGE = "curlimages/curl:latest";
const ACTIVE_DEADLINE_SECONDS = 3600;

export interface CronJobStatus {
  lastScheduleTime?: Date;
  active: number;
  suspended: boolean;
}

/**
 * Manages Kubernetes CronJobs for knowledge graph connector sync schedules.
 */
class CronJobManager {
  private batchApi: k8s.BatchV1Api | null = null;
  private namespace = "default";
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;

    try {
      const { kubeConfig, namespace } = loadKubeConfig();
      const clients: K8sClients = createK8sClients(kubeConfig, namespace);
      this.batchApi = clients.batchApi;
      this.namespace = clients.namespace;
      this.initialized = true;
      logger.info("CronJobManager initialized successfully");
    } catch (error) {
      logger.error({ err: error }, "Failed to initialize CronJobManager");
      this.batchApi = null;
    }
  }

  async createOrUpdateCronJob(params: {
    connectorId: string;
    schedule: string;
    backendUrl: string;
    hmacSecret: string;
  }): Promise<void> {
    const { connectorId, schedule, backendUrl, hmacSecret } = params;
    const cronJobName = this.buildCronJobName(connectorId);
    const syncUrl = `${backendUrl}/api/internal/connectors/${connectorId}/sync`;
    const timestamp = "$(date +%s)";
    const hmacSignature = this.buildHmacCurlCommand();

    const cronJobSpec: k8s.V1CronJob = {
      metadata: {
        name: cronJobName,
        namespace: this.namespace,
        labels: {
          app: "archestra-connector",
          "connector-id": sanitizeLabelValue(connectorId),
        },
      },
      spec: {
        schedule,
        concurrencyPolicy: "Forbid",
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 3,
        jobTemplate: {
          spec: {
            activeDeadlineSeconds: ACTIVE_DEADLINE_SECONDS,
            backoffLimit: 2,
            template: {
              spec: {
                restartPolicy: "Never",
                containers: [
                  {
                    name: "sync",
                    image: CONTAINER_IMAGE,
                    command: ["/bin/sh", "-c"],
                    args: [
                      [
                        `TIMESTAMP=${timestamp}`,
                        `SIGNATURE=$(echo -n "$TIMESTAMP" | ${hmacSignature})`,
                        `curl -sf -X POST "${syncUrl}"`,
                        `-H "Content-Type: application/json"`,
                        `-H "X-Archestra-Signature: $SIGNATURE"`,
                        `-H "X-Archestra-Timestamp: $TIMESTAMP"`,
                      ].join(" && "),
                    ],
                    env: [
                      {
                        name: "HMAC_SECRET",
                        value: hmacSecret,
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    };

    try {
      await this.api.readNamespacedCronJob({
        name: cronJobName,
        namespace: this.namespace,
      });
      await this.api.replaceNamespacedCronJob({
        name: cronJobName,
        namespace: this.namespace,
        body: cronJobSpec,
      });
      logger.info(
        { connectorId, cronJobName },
        "Updated existing CronJob for connector",
      );
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        await this.api.createNamespacedCronJob({
          namespace: this.namespace,
          body: cronJobSpec,
        });
        logger.info(
          { connectorId, cronJobName },
          "Created new CronJob for connector",
        );
      } else {
        throw error;
      }
    }
  }

  async deleteCronJob(connectorId: string): Promise<void> {
    const cronJobName = this.buildCronJobName(connectorId);
    try {
      await this.api.deleteNamespacedCronJob({
        name: cronJobName,
        namespace: this.namespace,
      });
      logger.info(
        { connectorId, cronJobName },
        "Deleted CronJob for connector",
      );
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        logger.debug(
          { connectorId, cronJobName },
          "CronJob not found, nothing to delete",
        );
      } else {
        throw error;
      }
    }
  }

  async suspendCronJob(connectorId: string): Promise<void> {
    const cronJobName = this.buildCronJobName(connectorId);
    await this.api.patchNamespacedCronJob({
      name: cronJobName,
      namespace: this.namespace,
      body: { spec: { suspend: true } },
    });
    logger.info(
      { connectorId, cronJobName },
      "Suspended CronJob for connector",
    );
  }

  async resumeCronJob(connectorId: string): Promise<void> {
    const cronJobName = this.buildCronJobName(connectorId);
    await this.api.patchNamespacedCronJob({
      name: cronJobName,
      namespace: this.namespace,
      body: { spec: { suspend: false } },
    });
    logger.info({ connectorId, cronJobName }, "Resumed CronJob for connector");
  }

  async getCronJobStatus(connectorId: string): Promise<CronJobStatus | null> {
    const cronJobName = this.buildCronJobName(connectorId);
    try {
      const cronJob = await this.api.readNamespacedCronJob({
        name: cronJobName,
        namespace: this.namespace,
      });

      return {
        lastScheduleTime: cronJob.status?.lastScheduleTime
          ? new Date(cronJob.status.lastScheduleTime as unknown as string)
          : undefined,
        active: cronJob.status?.active?.length ?? 0,
        suspended: cronJob.spec?.suspend ?? false,
      };
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  private get api(): k8s.BatchV1Api {
    if (!this.batchApi) {
      throw new Error(
        "CronJobManager not initialized. Call initialize() first.",
      );
    }
    return this.batchApi;
  }

  private buildCronJobName(connectorId: string): string {
    const sanitized = sanitizeLabelValue(connectorId);
    return `${CRONJOB_NAME_PREFIX}-${sanitized}`;
  }

  private buildHmacCurlCommand(): string {
    return 'openssl dgst -sha256 -hmac "$HMAC_SECRET" | cut -d" " -f2';
  }
}

export const cronJobManager = new CronJobManager();

// ============================================================
// Internal helpers
// ============================================================

function sanitizeLabelValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/^[^a-z0-9]/, "a")
    .slice(0, 63);
}

function isK8sNotFoundError(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    (error as { statusCode: number }).statusCode === 404
  ) {
    return true;
  }
  if (
    error &&
    typeof error === "object" &&
    "response" in error &&
    (error as { response: { statusCode: number } }).response?.statusCode === 404
  ) {
    return true;
  }
  return false;
}
