import type * as k8s from "@kubernetes/client-node";
import config, { CONNECTOR_CONTINUATION_COUNT_ENV_VAR } from "@/config";
import { inProcessScheduler } from "@/k8s/cron-job/in-process-scheduler";
import {
  createK8sClients,
  isK8sNotFoundError,
  type K8sClients,
  loadKubeConfig,
  sanitizeLabelValue,
} from "@/k8s/shared";
import logger from "@/logging";

/**
 * Manages Kubernetes CronJobs for connector sync workloads.
 */
class CronJobManager {
  private batchApi: k8s.BatchV1Api | null = null;
  private namespace = config.kb.connectorNamespace;
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;

    try {
      const { kubeConfig } = loadKubeConfig();
      const connectorNamespace = config.kb.connectorNamespace;
      const clients: K8sClients = createK8sClients(
        kubeConfig,
        connectorNamespace,
      );
      this.batchApi = clients.batchApi;
      this.namespace = clients.namespace;
      this.initialized = true;
      logger.info(
        { namespace: connectorNamespace },
        "CronJobManager initialized successfully",
      );
    } catch (error) {
      logger.error({ err: error }, "Failed to initialize CronJobManager");
      this.batchApi = null;
    }
  }

  async createOrUpdateCronJob(params: {
    connectorId: string;
    schedule: string;
  }): Promise<void> {
    const containerImage = config.kb.connectorImage;
    if (!containerImage) {
      inProcessScheduler.schedule(params);
      return;
    }

    const cronJobName = this.buildCronJobName(params.connectorId);
    const cronJob = buildK8sCronJob({
      name: cronJobName,
      namespace: this.namespace,
      schedule: params.schedule,
      connectorId: params.connectorId,
      containerImage,
      env: buildConnectorSyncEnv(),
    });

    try {
      await this.api.readNamespacedCronJob({
        name: cronJobName,
        namespace: this.namespace,
      });
      await this.api.replaceNamespacedCronJob({
        name: cronJobName,
        namespace: this.namespace,
        body: cronJob,
      });
      logger.info({ cronJobName }, "Updated existing CronJob");
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        await this.api.createNamespacedCronJob({
          namespace: this.namespace,
          body: cronJob,
        });
        logger.info({ cronJobName }, "Created new CronJob");
      } else {
        throw error;
      }
    }
  }

  async deleteCronJob(connectorId: string): Promise<void> {
    inProcessScheduler.unschedule(connectorId);

    if (!config.kb.connectorImage) {
      return;
    }

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
    if (!config.kb.connectorImage) {
      inProcessScheduler.suspend(connectorId);
      return;
    }

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
    if (!config.kb.connectorImage) {
      inProcessScheduler.resume(connectorId);
      return;
    }

    const cronJobName = this.buildCronJobName(connectorId);
    await this.api.patchNamespacedCronJob({
      name: cronJobName,
      namespace: this.namespace,
      body: { spec: { suspend: false } },
    });
    logger.info({ connectorId, cronJobName }, "Resumed CronJob for connector");
  }

  async triggerContinuationJob(params: {
    connectorId: string;
    continuationCount: number;
  }): Promise<void> {
    const containerImage = config.kb.connectorImage;
    if (!containerImage) {
      // In-process mode: continuation is handled by InProcessScheduler
      return;
    }

    const sanitizedId = sanitizeLabelValue(params.connectorId);
    const jobName = `ac-cont-${sanitizedId}-${params.continuationCount}`.slice(
      0,
      MAX_CRONJOB_NAME_LENGTH,
    );

    const env = buildConnectorSyncEnv();
    // Override/add continuation count env var
    const filteredEnv = env.filter(
      (e) => e.name !== CONNECTOR_CONTINUATION_COUNT_ENV_VAR,
    );
    filteredEnv.push({
      name: CONNECTOR_CONTINUATION_COUNT_ENV_VAR,
      value: String(params.continuationCount),
    });

    const job: k8s.V1Job = {
      metadata: {
        name: jobName,
        namespace: this.namespace,
        labels: {
          app: "archestra-connector",
          "connector-id": sanitizedId,
          "continuation-count": String(params.continuationCount),
        },
      },
      spec: {
        activeDeadlineSeconds: ACTIVE_DEADLINE_SECONDS,
        backoffLimit: 0,
        ttlSecondsAfterFinished: 3600,
        template: {
          metadata: {
            labels: {
              app: "archestra-connector",
              "connector-id": sanitizedId,
            },
          },
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "worker",
                image: containerImage,
                command: ["node", "--enable-source-maps"],
                args: [
                  "dist/entrypoints/connector-sync.mjs",
                  `--connector-id=${params.connectorId}`,
                ],
                workingDir: "/app/backend",
                env: filteredEnv.map((e) => ({
                  name: e.name,
                  value: e.value,
                })),
              },
            ],
          },
        },
      },
    };

    try {
      await this.api.createNamespacedJob({
        namespace: this.namespace,
        body: job,
      });
      logger.info(
        {
          connectorId: params.connectorId,
          jobName,
          continuationCount: params.continuationCount,
        },
        "Created continuation Job",
      );
    } catch (error) {
      logger.error(
        {
          connectorId: params.connectorId,
          err: error,
        },
        "Failed to create continuation Job",
      );
    }
  }

  async getCronJobStatus(connectorId: string): Promise<{
    lastScheduleTime?: Date;
    active: number;
    suspended: boolean;
  } | null> {
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
    return `${CRONJOB_NAME_PREFIX}-${sanitized}`.slice(
      0,
      MAX_CRONJOB_NAME_LENGTH,
    );
  }
}

export const cronJobManager = new CronJobManager();

// ============================================================
// Internal helpers
// ============================================================

const CRONJOB_NAME_PREFIX = "ac-sync";
const ACTIVE_DEADLINE_SECONDS = 3600;
/** K8s CronJob names are limited to 52 characters. */
const MAX_CRONJOB_NAME_LENGTH = 52;

/**
 * Builds the env var array for connector sync CronJob pods.
 * Forwards all ARCHESTRA_* and DATABASE_URL env vars from the current process
 * so the entrypoint has access to database, secrets manager, and logging config.
 */
export function buildConnectorSyncEnv(): Array<{
  name: string;
  value: string;
}> {
  const env: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (value && (name.startsWith("ARCHESTRA_") || name === "DATABASE_URL")) {
      env.push({ name, value });
    }
  }
  return env;
}

function buildK8sCronJob(params: {
  name: string;
  namespace: string;
  schedule: string;
  connectorId: string;
  containerImage: string;
  env: Array<{ name: string; value: string }>;
}): k8s.V1CronJob {
  return {
    metadata: {
      name: params.name,
      namespace: params.namespace,
      labels: {
        app: "archestra-connector",
        "connector-id": sanitizeLabelValue(params.connectorId),
      },
    },
    spec: {
      schedule: params.schedule,
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          activeDeadlineSeconds: ACTIVE_DEADLINE_SECONDS,
          backoffLimit: 2,
          template: {
            metadata: {
              labels: {
                app: "archestra-connector",
                "connector-id": sanitizeLabelValue(params.connectorId),
              },
            },
            spec: {
              restartPolicy: "Never",
              containers: [
                {
                  name: "worker",
                  image: params.containerImage,
                  command: ["node", "--enable-source-maps"],
                  args: [
                    "dist/entrypoints/connector-sync.mjs",
                    `--connector-id=${params.connectorId}`,
                  ],
                  workingDir: "/app/backend",
                  env: params.env.map((e) => ({
                    name: e.name,
                    value: e.value,
                  })),
                },
              ],
            },
          },
        },
      },
    },
  };
}
