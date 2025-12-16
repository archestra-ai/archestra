import { PassThrough } from "node:stream";
import type * as k8s from "@kubernetes/client-node";
import type { Attach } from "@kubernetes/client-node";
import type { LocalConfigSchema } from "@shared";
import type z from "zod";
import config from "@/config";
import logger from "@/logging";
import { InternalMcpCatalogModel } from "@/models";
import type { InternalMcpCatalog, McpServer } from "@/types";
import type { K8sPodState, K8sPodStatusSummary } from "./schemas";

const {
  orchestrator: { mcpServerBaseImage },
} = config;

/**
 * K8sPod manages a single MCP server running as a Kubernetes pod.
 * This is analogous to PodmanContainer in the desktop app.
 */
export default class K8sPod {
  private mcpServer: McpServer;
  private k8sApi: k8s.CoreV1Api;
  private k8sAttach: Attach;
  private k8sLog: k8s.Log;
  private namespace: string;
  private podName: string;
  private state: K8sPodState = "not_created";
  private errorMessage: string | null = null;
  private catalogItem?: InternalMcpCatalog | null;
  private userConfigValues?: Record<string, string>;
  private environmentValues?: Record<string, string>;

  // Track assigned port for HTTP-based MCP servers
  assignedHttpPort?: number;
  // Track the HTTP endpoint URL for streamable-http servers
  httpEndpointUrl?: string;

  constructor(
    mcpServer: McpServer,
    k8sApi: k8s.CoreV1Api,
    k8sAttach: Attach,
    k8sLog: k8s.Log,
    namespace: string,
    catalogItem?: InternalMcpCatalog | null,
    userConfigValues?: Record<string, string>,
    environmentValues?: Record<string, string>,
  ) {
    this.mcpServer = mcpServer;
    this.k8sApi = k8sApi;
    this.k8sAttach = k8sAttach;
    this.k8sLog = k8sLog;
    this.namespace = namespace;
    this.catalogItem = catalogItem;
    this.userConfigValues = userConfigValues;
    this.environmentValues = environmentValues;
    this.podName = K8sPod.constructPodName(mcpServer);
  }

  /**
   * Constructs a valid Kubernetes pod name for an MCP server.
   *
   * Creates a pod name in the format "mcp-<slugified-name>".
   */
  static constructPodName(mcpServer: McpServer): string {
    const slugified = K8sPod.ensureStringIsRfc1123Compliant(mcpServer.name);
    return `mcp-${slugified}`.substring(0, 253);
  }

  /**
   * Constructs the Kubernetes Secret name for an MCP server.
   *
   * Creates a secret name in the format "mcp-server-{id}-secrets".
   */
  static constructK8sSecretName(mcpServerId: string): string {
    return `mcp-server-${mcpServerId}-secrets`;
  }

  /**
   * Ensures a string is RFC 1123 compliant for Kubernetes DNS subdomain names and label values.
   *
   * According to RFC 1123, Kubernetes DNS subdomain names must:
   * - contain no more than 253 characters
   * - contain only lowercase alphanumeric characters, '-' or '.'
   * - start with an alphanumeric character
   * - end with an alphanumeric character
   */
  static ensureStringIsRfc1123Compliant(input: string): string {
    return input
      .toLowerCase()
      .replace(/\s+/g, "-") // replace any whitespace with hyphens
      .replace(/[^a-z0-9.-]/g, "") // remove invalid characters
      .replace(/-+/g, "-") // collapse consecutive hyphens
      .replace(/\.+/g, ".") // collapse consecutive dots
      .replace(/^[^a-z0-9]+/, "") // remove leading non-alphanumeric
      .replace(/[^a-z0-9]+$/, ""); // remove trailing non-alphanumeric
  }

  /**
   * Sanitizes metadata labels to ensure all keys and values are RFC 1123 compliant.
   * Also ensures values are no longer than 63 characters as per Kubernetes label requirements.
   */
  static sanitizeMetadataLabels(
    labels: Record<string, string>,
  ): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(labels)) {
      // Labels values must be 63 characters or less and end with alphanumeric
      const compliantValue = K8sPod.ensureStringIsRfc1123Compliant(value)
        .substring(0, 63)
        .replace(/[^a-z0-9]+$/, "");

      sanitized[K8sPod.ensureStringIsRfc1123Compliant(key)] = compliantValue;
    }
    return sanitized;
  }

  /**
   * Get catalog item for this MCP server
   */
  private async getCatalogItem(): Promise<InternalMcpCatalog | null> {
    if (!this.mcpServer.catalogId) {
      return null;
    }

    return await InternalMcpCatalogModel.findById(this.mcpServer.catalogId);
  }

  /**
   * Create or update a Kubernetes Secret for environment variables marked as "secret" type
   */
  async createK8sSecret(secretData: Record<string, string>): Promise<void> {
    const k8sSecretName = K8sPod.constructK8sSecretName(this.mcpServer.id);

    if (Object.keys(secretData).length === 0) {
      logger.debug(
        { mcpServerId: this.mcpServer.id },
        "No secret data provided, skipping K8s Secret creation",
      );
      return;
    }

    try {
      // Convert secret data to base64 (K8s requires base64 encoding for secret values)
      const data: Record<string, string> = {};
      for (const [key, value] of Object.entries(secretData)) {
        data[key] = Buffer.from(value).toString("base64");
      }

      const secret: k8s.V1Secret = {
        metadata: {
          name: k8sSecretName,
          labels: K8sPod.sanitizeMetadataLabels({
            app: "mcp-server",
            "mcp-server-id": this.mcpServer.id,
            "mcp-server-name": this.mcpServer.name,
          }),
        },
        type: "Opaque",
        data,
      };

      try {
        // Try to create the secret
        await this.k8sApi.createNamespacedSecret({
          namespace: this.namespace,
          body: secret,
        });

        logger.info(
          {
            mcpServerId: this.mcpServer.id,
            secretName: k8sSecretName,
            namespace: this.namespace,
          },
          "Created K8s Secret for MCP server",
        );
      } catch (createError: unknown) {
        // If secret already exists (409), update it instead
        const isConflict =
          createError &&
          typeof createError === "object" &&
          (("statusCode" in createError && createError.statusCode === 409) ||
            ("code" in createError && createError.code === 409));

        if (isConflict) {
          logger.info(
            {
              mcpServerId: this.mcpServer.id,
              secretName: k8sSecretName,
              namespace: this.namespace,
            },
            "K8s Secret already exists, updating it",
          );

          await this.k8sApi.replaceNamespacedSecret({
            name: k8sSecretName,
            namespace: this.namespace,
            body: secret,
          });

          logger.info(
            {
              mcpServerId: this.mcpServer.id,
              secretName: k8sSecretName,
              namespace: this.namespace,
            },
            "Updated existing K8s Secret for MCP server",
          );
        } else {
          // Re-throw other errors
          throw createError;
        }
      }
    } catch (error) {
      logger.error(
        {
          err: error,
          mcpServerId: this.mcpServer.id,
          secretName: k8sSecretName,
        },
        "Failed to create or update K8s Secret",
      );
      throw error;
    }
  }

  /**
   * Delete the Kubernetes Secret for this MCP server
   */
  async deleteK8sSecret(): Promise<void> {
    const k8sSecretName = K8sPod.constructK8sSecretName(this.mcpServer.id);

    try {
      await this.k8sApi.deleteNamespacedSecret({
        name: k8sSecretName,
        namespace: this.namespace,
      });

      logger.info(
        {
          mcpServerId: this.mcpServer.id,
          secretName: k8sSecretName,
          namespace: this.namespace,
        },
        "Deleted K8s Secret for MCP server",
      );
    } catch (error: unknown) {
      // If secret doesn't exist (404), that's okay - it may have been deleted already or never created
      const is404 =
        error &&
        typeof error === "object" &&
        (("statusCode" in error && error.statusCode === 404) ||
          ("code" in error && error.code === 404));

      if (is404) {
        logger.debug(
          {
            mcpServerId: this.mcpServer.id,
            secretName: k8sSecretName,
          },
          "K8s Secret not found (already deleted or never created)",
        );
        return;
      }

      logger.error(
        {
          err: error,
          mcpServerId: this.mcpServer.id,
          secretName: k8sSecretName,
        },
        "Failed to delete K8s Secret",
      );
      throw error;
    }
  }

  /**
   * Generate the pod specification for this MCP server
   *
   * @param dockerImage - The Docker image to use for the container
   * @param localConfig - The local configuration for the MCP server
   * @param needsHttp - Whether the pod needs HTTP port exposure
   * @param httpPort - The HTTP port to expose (if needsHttp is true)
   * @returns The Kubernetes pod specification
   */
  generatePodSpec(
    dockerImage: string,
    localConfig: z.infer<typeof LocalConfigSchema>,
    needsHttp: boolean,
    httpPort: number,
  ): k8s.V1Pod {
    return {
      metadata: {
        name: this.podName,
        labels: K8sPod.sanitizeMetadataLabels({
          app: "mcp-server",
          "mcp-server-id": this.mcpServer.id,
          "mcp-server-name": this.mcpServer.name,
        }),
      },
      spec: {
        // Fast shutdown for stateless MCP servers (default is 30s)
        terminationGracePeriodSeconds: 5,
        // Use specified service account if provided in localConfig
        // This allows MCP servers that need Kubernetes API access (like the K8s MCP server)
        // to use a dedicated service account with appropriate permissions
        // Other MCP servers will use the default service account (no K8s permissions)
        // Automatically constructs full service account name: {releaseName}-mcp-k8s-{role}
        // Example: if role is "operator" and release is "archestra-platform", result is "archestra-platform-mcp-k8s-operator"
        ...(localConfig.serviceAccount
          ? {
              serviceAccountName: config.orchestrator.kubernetes
                .mcpK8sServiceAccountName
                ? `${config.orchestrator.kubernetes.mcpK8sServiceAccountName}-mcp-k8s-${localConfig.serviceAccount}`
                : localConfig.serviceAccount,
            }
          : {}),
        containers: [
          {
            name: "mcp-server",
            image: dockerImage,
            env: this.createPodEnvFromConfig(),
            /**
             * Use the command from local config if provided
             * If not provided, Kubernetes will use the Docker image's default CMD
             */
            ...(localConfig.command
              ? {
                  command: [localConfig.command],
                }
              : {}),
            args: (localConfig.arguments || []).map((arg) => {
              // Interpolate ${user_config.xxx} placeholders with actual values
              // Use environmentValues first (for internal catalog), fallback to userConfigValues (for external catalog)
              if (this.environmentValues || this.userConfigValues) {
                return arg.replace(
                  /\$\{user_config\.([^}]+)\}/g,
                  (match, configKey) => {
                    return (
                      this.environmentValues?.[configKey] ||
                      this.userConfigValues?.[configKey] ||
                      match
                    );
                  },
                );
              }
              return arg;
            }),
            // For stdio-based MCP servers, we use stdin/stdout
            stdin: true,
            tty: false,
            // For HTTP-based MCP servers, expose port
            ports: needsHttp
              ? [
                  {
                    containerPort: httpPort,
                    protocol: "TCP",
                  },
                ]
              : undefined,
            // Set resource requests for the container
            // It's needed to make k8s scheduler play nice with mcp server pods,
            // since k8s schedules pods and nodes based on resource requests and limits.
            resources: {
              requests: {
                memory: "128Mi",
                cpu: "50m",
              },
            },
          },
        ],
        restartPolicy: "Always",
      },
    };
  }

  /**
   * Rewrite localhost URLs to host.docker.internal for Docker Desktop Kubernetes.
   * This allows pods to access services running on the host machine.
   *
   * Note: This assumes Docker Desktop. Other local K8s environments may need different
   * hostnames (e.g., host.minikube.internal for Minikube, or host-gateway for kind).
   */
  private rewriteLocalhostUrl(value: string): string {
    try {
      const url = new URL(value);
      const isHttp = url.protocol === "http:" || url.protocol === "https:";
      if (!isHttp) {
        return value;
      }
      if (
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1"
      ) {
        url.hostname = "host.docker.internal";
        logger.info(
          {
            mcpServerId: this.mcpServer.id,
            originalUrl: value,
            rewrittenUrl: url.toString(),
          },
          "Rewrote localhost URL to host.docker.internal for K8s pod",
        );
        return url.toString();
      }
    } catch {
      // Not a valid URL, return as-is
    }
    return value;
  }

  /**
   * Create environment variables for the pod
   *
   * This method processes environment variables from the local config and ensures
   * that values are properly formatted. It strips surrounding quotes (both single
   * and double) from values, as they are often used as delimiters in the UI but
   * should not be part of the actual environment variable value.
   *
   * Additionally, it merges environment values passed from the frontend (for secrets
   * and user-provided values) with the catalog's plain text environment variables.
   *
   * For environment variables marked as "secret" type in the catalog, this method
   * will use valueFrom.secretKeyRef to reference the Kubernetes Secret instead of
   * including the value directly in the pod spec.
   *
   * For Docker Desktop Kubernetes environments, localhost URLs are automatically
   * rewritten to host.docker.internal to allow pods to access services on the host.
   */
  createPodEnvFromConfig(): k8s.V1EnvVar[] {
    const env: k8s.V1EnvVar[] = [];
    const envMap = new Map<string, string>();
    const secretEnvVars = new Set<string>();

    // Process all environment variables from catalog
    if (this.catalogItem?.localConfig?.environment) {
      for (const envDef of this.catalogItem.localConfig.environment) {
        // Track secret-type env vars
        if (envDef.type === "secret") {
          secretEnvVars.add(envDef.key);
        }

        // Add env var value to envMap based on prompting behavior
        let value: string | undefined;
        if (envDef.promptOnInstallation) {
          // Prompted during installation - get from environmentValues
          value = this.environmentValues?.[envDef.key];
        } else {
          // Static value from catalog - get from envDef.value
          value = envDef.value;

          // Interpolate ${user_config.xxx} placeholders with actual values
          // Use environmentValues first (for internal catalog), fallback to userConfigValues (for external catalog)
          if (value && (this.environmentValues || this.userConfigValues)) {
            value = value.replace(
              /\$\{user_config\.([^}]+)\}/g,
              (match, configKey) => {
                return (
                  this.environmentValues?.[configKey] ||
                  this.userConfigValues?.[configKey] ||
                  match
                );
              },
            );
          }
        }
        // Add to envMap if value exists, OR if it's a secret-type (needs secretKeyRef even without value)
        // Secret-type vars will reference K8s Secret via secretKeyRef, plain_text vars use value directly
        if (value || envDef.type === "secret") {
          envMap.set(envDef.key, value || "");
        }
      }
    } else if (this.environmentValues) {
      // Fallback: If no catalog item but environmentValues provided,
      // process them directly (backward compatibility for tests and direct usage)
      Object.entries(this.environmentValues).forEach(([key, value]) => {
        envMap.set(key, value);
      });
    }

    // Add user config values as environment variables
    if (this.userConfigValues) {
      Object.entries(this.userConfigValues).forEach(([key, value]) => {
        // Convert to uppercase with underscores for environment variable convention
        const envKey = key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
        envMap.set(envKey, value);
      });
    }

    // Convert map to k8s env vars, using conditional logic for secrets
    envMap.forEach((value, key) => {
      // If this env var is marked as "secret" type, use valueFrom.secretKeyRef
      if (secretEnvVars.has(key)) {
        // Skip secret-type env vars with empty values (no K8s Secret will be created)
        if (!value || value.trim() === "") {
          return;
        }
        const k8sSecretName = K8sPod.constructK8sSecretName(this.mcpServer.id);
        env.push({
          name: key,
          valueFrom: {
            secretKeyRef: {
              name: k8sSecretName,
              key: key,
            },
          },
        });
      } else {
        // For plain text env vars, use value directly
        let processedValue = String(value);

        // Strip surrounding quotes (both single and double)
        // Users may enter values like: API_KEY='my value' or API_KEY="my value"
        // We want to extract the actual value without the quotes
        // Only strip if the value has length > 1 to avoid stripping single quote chars
        if (
          processedValue.length > 1 &&
          ((processedValue.startsWith("'") && processedValue.endsWith("'")) ||
            (processedValue.startsWith('"') && processedValue.endsWith('"')))
        ) {
          processedValue = processedValue.slice(1, -1);
        }

        // Rewrite localhost URLs to host.docker.internal for Docker Desktop K8s
        // Only when backend is running on host machine (connecting to K8s from outside)
        // When backend runs inside cluster, pods shouldn't access host services
        if (!config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster) {
          processedValue = this.rewriteLocalhostUrl(processedValue);
        }

        env.push({
          name: key,
          value: processedValue,
        });
      }
    });

    return env;
  }

  /**
   * Create or start the pod for this MCP server
   */
  async startOrCreatePod(): Promise<void> {
    try {
      // Check if pod already exists
      try {
        const existingPod = await this.k8sApi.readNamespacedPod({
          name: this.podName,
          namespace: this.namespace,
        });

        if (existingPod.status?.phase === "Running") {
          this.state = "running";
          await this.assignHttpPortIfNeeded(existingPod);

          // Set HTTP endpoint URL if this is an HTTP server
          const needsHttp = await this.needsHttpPort();
          if (needsHttp) {
            const catalogItem = await this.getCatalogItem();
            const httpPort = catalogItem?.localConfig?.httpPort || 8080;
            const httpPath = catalogItem?.localConfig?.httpPath || "/mcp";

            // Use service DNS for in-cluster, localhost with NodePort for local dev
            let baseUrl: string | undefined;
            if (
              config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster
            ) {
              const serviceName = `${this.podName}-service`;
              baseUrl = `http://${serviceName}.${this.namespace}.svc.cluster.local:${httpPort}`;
            } else {
              // Local dev: get NodePort from service
              const serviceName = `${this.podName}-service`;
              try {
                const service = await this.k8sApi.readNamespacedService({
                  name: serviceName,
                  namespace: this.namespace,
                });

                const nodePort = service.spec?.ports?.[0]?.nodePort;
                if (nodePort) {
                  baseUrl = `http://localhost:${nodePort}`;
                }
              } catch (error) {
                logger.error(
                  { err: error },
                  `Could not read service ${serviceName} for existing pod`,
                );
              }
            }

            if (baseUrl) {
              this.httpEndpointUrl = `${baseUrl}${httpPath}`;
            }
          }

          logger.info(`Pod ${this.podName} is already running`);
          return;
        }

        // If pod exists but not running, delete and recreate
        if (existingPod.status?.phase === "Failed") {
          logger.info(`Deleting failed pod ${this.podName}`);
          await this.removePod();
        }
        // biome-ignore lint/suspicious/noExplicitAny: TODO: fix this type..
      } catch (error: any) {
        // Pod doesn't exist, we'll create it below
        if (error?.code !== 404 && error?.statusCode !== 404) {
          throw error;
        }
        // 404 means pod doesn't exist, which is fine - we'll create it
      }

      // Get catalog item to get local config
      const catalogItem = await this.getCatalogItem();

      if (!catalogItem?.localConfig) {
        throw new Error(
          `Local config not found for MCP server ${this.mcpServer.name}`,
        );
      }

      // Create new pod
      logger.info(
        `Creating pod ${this.podName} for MCP server ${this.mcpServer.name}`,
      );
      if (catalogItem.localConfig.command) {
        logger.info(
          `Using command: ${catalogItem.localConfig.command} ${(catalogItem.localConfig.arguments || []).join(" ")}`,
        );
      } else {
        logger.info("Using Docker image's default CMD");
      }
      this.state = "pending";

      // Use custom Docker image if provided, otherwise use the base image
      const dockerImage =
        catalogItem.localConfig.dockerImage || mcpServerBaseImage;
      logger.info(`Using Docker image: ${dockerImage}`);

      // Check if HTTP port is needed
      const needsHttp = await this.needsHttpPort();
      const httpPort = catalogItem.localConfig.httpPort || 8080;

      // Normalize localConfig to ensure required and description have defaults
      const normalizedLocalConfig = {
        ...catalogItem.localConfig,
        environment: catalogItem.localConfig.environment?.map((env) => ({
          ...env,
          required: env.required ?? false,
          description: env.description ?? "",
        })),
      };

      const createdPod = await this.k8sApi.createNamespacedPod({
        namespace: this.namespace,
        body: this.generatePodSpec(
          dockerImage,
          normalizedLocalConfig,
          needsHttp,
          httpPort,
        ),
      });

      logger.info(
        `Pod ${this.podName} created, will check status asynchronously`,
      );

      // For HTTP servers, create a K8s Service and set endpoint URL
      if (needsHttp) {
        await this.createServiceForHttpServer(httpPort);

        // Get HTTP path from config (default to /mcp)
        const httpPath = catalogItem.localConfig.httpPath || "/mcp";

        // Use service DNS for in-cluster, localhost with NodePort for local dev
        let baseUrl: string;
        if (config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster) {
          // In-cluster: use service DNS name
          const serviceName = `${this.podName}-service`;
          baseUrl = `http://${serviceName}.${this.namespace}.svc.cluster.local:${httpPort}`;
        } else {
          // Local dev: get NodePort from service
          const serviceName = `${this.podName}-service`;
          const service = await this.k8sApi.readNamespacedService({
            name: serviceName,
            namespace: this.namespace,
          });

          const nodePort = service.spec?.ports?.[0]?.nodePort;
          if (!nodePort) {
            throw new Error(`Service ${serviceName} has no NodePort assigned`);
          }

          baseUrl = `http://localhost:${nodePort}`;
        }

        // Append the HTTP path
        this.httpEndpointUrl = `${baseUrl}${httpPath}`;

        logger.info(
          `HTTP endpoint URL for ${this.podName}: ${this.httpEndpointUrl}`,
        );
      }

      // Assign HTTP port if needed
      await this.assignHttpPortIfNeeded(createdPod);

      this.state = "running";
      logger.info(`Pod ${this.podName} is now running`);
    } catch (error: unknown) {
      this.state = "failed";
      this.errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: error }, `Failed to start pod ${this.podName}:`);
      throw error;
    }
  }

  /**
   * Check if this MCP server needs an HTTP port
   */
  private async needsHttpPort(): Promise<boolean> {
    const catalogItem = await this.getCatalogItem();
    if (!catalogItem?.localConfig) {
      return false;
    }
    // Default to stdio if transportType is not specified
    const transportType = catalogItem.localConfig.transportType || "stdio";
    return transportType === "streamable-http";
  }

  /**
   * Create a K8s Service for HTTP-based MCP servers
   */
  private async createServiceForHttpServer(httpPort: number): Promise<void> {
    const serviceName = `${this.podName}-service`;

    try {
      // Check if service already exists
      try {
        await this.k8sApi.readNamespacedService({
          name: serviceName,
          namespace: this.namespace,
        });
        logger.info(`Service ${serviceName} already exists`);
        return;
        // biome-ignore lint/suspicious/noExplicitAny: k8s error handling
      } catch (error: any) {
        // Service doesn't exist, we'll create it below
        if (error?.code !== 404 && error?.statusCode !== 404) {
          throw error;
        }
      }

      // Create the service
      // Use NodePort for local dev, ClusterIP for production
      const serviceType = config.orchestrator.kubernetes
        .loadKubeconfigFromCurrentCluster
        ? "ClusterIP"
        : "NodePort";

      const serviceSpec: k8s.V1Service = {
        metadata: {
          name: serviceName,
          labels: {
            app: "mcp-server",
            "mcp-server-id": this.mcpServer.id,
          },
        },
        spec: {
          selector: {
            app: "mcp-server",
            "mcp-server-id": this.mcpServer.id,
          },
          ports: [
            {
              protocol: "TCP",
              port: httpPort,
              targetPort: httpPort as unknown as k8s.IntOrString,
            },
          ],
          type: serviceType,
        },
      };

      await this.k8sApi.createNamespacedService({
        namespace: this.namespace,
        body: serviceSpec,
      });

      logger.info(`Created service ${serviceName} for pod ${this.podName}`);
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to create service for pod ${this.podName}:`,
      );
      throw error;
    }
  }

  /**
   * Assign HTTP port from the pod/service
   */
  private async assignHttpPortIfNeeded(pod: k8s.V1Pod): Promise<void> {
    const needsHttp = await this.needsHttpPort();
    if (needsHttp && pod.status?.podIP) {
      const catalogItem = await this.getCatalogItem();
      const httpPort = catalogItem?.localConfig?.httpPort || 8080;
      // Use the container port directly with pod IP
      this.assignedHttpPort = httpPort;
      logger.info(
        `Assigned HTTP port ${this.assignedHttpPort} for pod ${this.podName}`,
      );
    }
  }

  /**
   * Wait for pod to be in running state
   */
  async waitForPodReady(maxAttempts = 60, intervalMs = 2000): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const pod = await this.k8sApi.readNamespacedPod({
          name: this.podName,
          namespace: this.namespace,
        });

        // Check for failure states in container statuses
        if (pod.status?.containerStatuses) {
          for (const containerStatus of pod.status.containerStatuses) {
            const waitingReason = containerStatus.state?.waiting?.reason;
            if (waitingReason) {
              const failureStates = [
                "CrashLoopBackOff",
                "ImagePullBackOff",
                "ErrImagePull",
                "CreateContainerConfigError",
                "CreateContainerError",
                "RunContainerError",
              ];
              if (failureStates.includes(waitingReason)) {
                const message =
                  containerStatus.state?.waiting?.message ||
                  `Container in ${waitingReason} state`;
                this.state = "failed";
                this.errorMessage = message;
                throw new Error(
                  `Pod ${this.podName} failed: ${waitingReason} - ${message}`,
                );
              }
            }
          }
        }

        if (pod.status?.phase === "Running") {
          // Check if all containers are ready
          const allReady = pod.status.containerStatuses?.every(
            (status) => status.ready,
          );
          if (allReady) {
            return;
          }
        }

        if (pod.status?.phase === "Failed") {
          this.state = "failed";
          this.errorMessage = `Pod phase is Failed`;
          throw new Error(`Pod ${this.podName} failed to start`);
        }
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          (error.message.includes("failed to start") ||
            error.message.includes("failed:"))
        ) {
          throw error;
        }
        // Continue waiting for other errors (e.g., network issues)
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `Pod ${this.podName} did not become ready after ${maxAttempts} attempts`,
    );
  }

  /**
   * Stop the pod (fire-and-forget - K8s handles cleanup in background)
   */
  async stopPod(): Promise<void> {
    try {
      logger.info(`Stopping pod ${this.podName}`);
      await this.k8sApi.deleteNamespacedPod({
        name: this.podName,
        namespace: this.namespace,
      });
      logger.info(`Pod ${this.podName} deletion initiated`);
      this.state = "not_created";
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("404")) {
        // Pod already doesn't exist, that's fine
        logger.info(`Pod ${this.podName} already deleted`);
        this.state = "not_created";
        return;
      }
      logger.error({ err: error }, `Failed to stop pod ${this.podName}:`);
      throw error;
    }
  }

  /**
   * Remove the pod completely
   */
  async removePod(): Promise<void> {
    await this.stopPod();
    await this.deleteK8sSecret();
  }

  /**
   * Get recent logs from the pod
   */
  async getRecentLogs(lines: number = 100): Promise<string> {
    try {
      const logs = await this.k8sApi.readNamespacedPodLog({
        name: this.podName,
        namespace: this.namespace,
        tailLines: lines,
      });

      return logs || "";
    } catch (error: unknown) {
      logger.error(
        { err: error },
        `Failed to get logs for pod ${this.podName}:`,
      );
      if (error instanceof Error && error.message.includes("404")) {
        return "Pod not found";
      }
      throw error;
    }
  }

  /**
   * Stream logs from the pod with follow enabled
   */
  async streamLogs(
    responseStream: NodeJS.WritableStream,
    lines: number = 100,
  ): Promise<void> {
    try {
      // Create a PassThrough stream to handle the log data
      const logStream = new PassThrough();

      // Handle log data by piping to the response stream
      logStream.on("data", (chunk) => {
        if (!("destroyed" in responseStream) || !responseStream.destroyed) {
          responseStream.write(chunk);
        }
      });

      // Handle stream errors
      logStream.on("error", (error) => {
        logger.error(
          { err: error },
          `Log stream error for pod ${this.podName}:`,
        );
        if (!("destroyed" in responseStream) || !responseStream.destroyed) {
          if (
            "destroy" in responseStream &&
            typeof responseStream.destroy === "function"
          ) {
            responseStream.destroy(error);
          }
        }
      });

      // Handle stream end
      logStream.on("end", () => {
        if (!("destroyed" in responseStream) || !responseStream.destroyed) {
          responseStream.end();
        }
      });

      // Handle response stream errors and cleanup
      responseStream.on("error", (error) => {
        logger.error(
          { err: error },
          `Response stream error for pod ${this.podName}:`,
        );
        if (logStream.destroy) {
          logStream.destroy();
        }
      });

      responseStream.on("close", () => {
        if (logStream.destroy) {
          logStream.destroy();
        }
      });

      // Use the Log client to stream logs with follow=true
      const req = await this.k8sLog.log(
        this.namespace,
        this.podName,
        "mcp-server", // container name
        logStream,
        {
          follow: true,
          tailLines: lines,
          pretty: false,
          timestamps: false,
        },
      );

      // Handle cleanup when response stream closes
      responseStream.on("close", () => {
        if (req) {
          req.abort();
        }
      });
    } catch (error: unknown) {
      logger.error(
        { err: error },
        `Failed to stream logs for pod ${this.podName}:`,
      );

      if (!("destroyed" in responseStream) || !responseStream.destroyed) {
        if (
          "destroy" in responseStream &&
          typeof responseStream.destroy === "function"
        ) {
          responseStream.destroy(error as Error);
        }
      }

      throw error;
    }
  }

  /**
   * Get the pod's status summary
   */
  get statusSummary(): K8sPodStatusSummary {
    return {
      state: this.state,
      message:
        this.state === "running"
          ? "Pod is running"
          : this.state === "pending"
            ? "Pod is starting"
            : this.state === "failed"
              ? "Pod failed"
              : "Pod not created",
      error: this.errorMessage,
      podName: this.podName,
      namespace: this.namespace,
    };
  }

  get containerName(): string {
    return this.podName;
  }

  /**
   * Get the Kubernetes Attach API client
   */
  get k8sAttachClient(): Attach {
    return this.k8sAttach;
  }

  /**
   * Get the Kubernetes namespace
   */
  get k8sNamespace(): string {
    return this.namespace;
  }

  /**
   * Get the pod name
   */
  get k8sPodName(): string {
    return this.podName;
  }

  /**
   * Check if this pod uses streamable HTTP transport
   */
  async usesStreamableHttp(): Promise<boolean> {
    return await this.needsHttpPort();
  }

  /**
   * Get the HTTP endpoint URL for streamable-http servers
   */
  getHttpEndpointUrl(): string | undefined {
    return this.httpEndpointUrl;
  }
}
