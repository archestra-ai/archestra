import type * as k8s from "@kubernetes/client-node";
import config from "@/config";
import {
  createK8sClients,
  isK8sNotFoundError,
  type K8sClients,
  loadKubeConfig,
  sanitizeLabelValue,
} from "@/k8s/shared";
import logger from "@/logging";

/**
 * Generic specification for creating a Kubernetes CronJob.
 * Used by CronJobManager to create or update CronJobs for any scheduled workload.
 */
export interface CronJobSpec {
  name: string;
  namespace: string;
  schedule: string;
  containerImage: string;
  command: string[];
  args: string[];
  workingDir?: string;
  env?: Array<{ name: string; value: string }>;
  labels: Record<string, string>;
  activeDeadlineSeconds?: number;
  concurrencyPolicy?: string;
}

export interface CronJobStatus {
  lastScheduleTime?: Date;
  active: number;
  suspended: boolean;
}

/**
 * Builds a CronJobSpec for a connector sync CronJob.
 * Runs the connector-sync entrypoint directly in the backend image,
 * which talks to the database and captures full sync logs.
 */
export function buildConnectorSyncCronJobSpec(params: {
  connectorId: string;
  schedule: string;
  containerImage: string;
  env?: Array<{ name: string; value: string }>;
  namespace: string;
}): CronJobSpec {
  const { connectorId, schedule, containerImage, namespace } = params;

  return {
    name: `${CRONJOB_NAME_PREFIX}-${sanitizeLabelValue(connectorId)}`,
    namespace,
    schedule,
    containerImage,
    command: ["node", "--enable-source-maps"],
    args: [
      "dist/entrypoints/connector-sync.mjs",
      `--connector-id=${connectorId}`,
    ],
    workingDir: "/app/backend",
    env: params.env,
    labels: {
      app: "archestra-connector",
      "connector-id": sanitizeLabelValue(connectorId),
    },
    activeDeadlineSeconds: ACTIVE_DEADLINE_SECONDS,
    concurrencyPolicy: "Forbid",
  };
}

/**
 * Manages Kubernetes CronJobs for scheduled workloads.
 * Generic core that accepts CronJobSpec; convenience methods wrap connector-specific logic.
 */
class CronJobManager {
  private batchApi: k8s.BatchV1Api | null = null;
  private namespace = "archestra-connectors";
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;

    try {
      const { kubeConfig } = loadKubeConfig();
      const connectorNamespace = config.orchestrator.connectorNamespace;
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

  /**
   * Creates or updates a CronJob from a generic CronJobSpec.
   * If the CronJob already exists, it is replaced; otherwise a new one is created.
   */
  async createOrUpdateFromSpec(spec: CronJobSpec): Promise<void> {
    const k8sCronJob = this.specToK8sCronJob(spec);

    try {
      await this.api.readNamespacedCronJob({
        name: spec.name,
        namespace: spec.namespace,
      });
      await this.api.replaceNamespacedCronJob({
        name: spec.name,
        namespace: spec.namespace,
        body: k8sCronJob,
      });
      logger.info({ cronJobName: spec.name }, "Updated existing CronJob");
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        await this.api.createNamespacedCronJob({
          namespace: spec.namespace,
          body: k8sCronJob,
        });
        logger.info({ cronJobName: spec.name }, "Created new CronJob");
      } else {
        throw error;
      }
    }
  }

  /**
   * Convenience: creates or updates a connector sync CronJob.
   * Reads the container image and env vars from config/process.env.
   */
  async createOrUpdateCronJob(params: {
    connectorId: string;
    schedule: string;
  }): Promise<void> {
    const spec = buildConnectorSyncCronJobSpec({
      connectorId: params.connectorId,
      schedule: params.schedule,
      containerImage: config.orchestrator.connectorImage,
      env: buildConnectorSyncEnv(),
      namespace: this.namespace,
    });
    await this.createOrUpdateFromSpec(spec);
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

  private specToK8sCronJob(spec: CronJobSpec): k8s.V1CronJob {
    return {
      metadata: {
        name: spec.name,
        namespace: spec.namespace,
        labels: spec.labels,
      },
      spec: {
        schedule: spec.schedule,
        concurrencyPolicy: spec.concurrencyPolicy ?? "Forbid",
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 3,
        jobTemplate: {
          spec: {
            activeDeadlineSeconds: spec.activeDeadlineSeconds ?? 3600,
            backoffLimit: 2,
            template: {
              spec: {
                restartPolicy: "Never",
                containers: [
                  {
                    name: "worker",
                    image: spec.containerImage,
                    command: spec.command,
                    args: spec.args,
                    workingDir: spec.workingDir,
                    env: spec.env?.map((e) => ({
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
}

export const cronJobManager = new CronJobManager();

// ============================================================
// Internal constants
// ============================================================

const CRONJOB_NAME_PREFIX = "archestra-connector";
const ACTIVE_DEADLINE_SECONDS = 3600;

/**
 * Builds the env var array for connector sync CronJob pods.
 * Forwards all ARCHESTRA_* and DATABASE_URL env vars from the current process
 * so the entrypoint has access to database, secrets manager, and logging config.
 */
function buildConnectorSyncEnv(): Array<{ name: string; value: string }> {
  const env: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (value && (name.startsWith("ARCHESTRA_") || name === "DATABASE_URL")) {
      env.push({ name, value });
    }
  }
  return env;
}
