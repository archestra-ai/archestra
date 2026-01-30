import { PassThrough } from "node:stream";
import type * as k8s from "@kubernetes/client-node";
import type { Attach } from "@kubernetes/client-node";
import { type LocalConfigSchema, MCP_ORCHESTRATOR_DEFAULTS } from "@shared";
import type z from "zod";
import config from "@/config";
import logger from "@/logging";
import { InternalMcpCatalogModel } from "@/models";
import type { InternalMcpCatalog, McpServer } from "@/types";
import type { K8sDeploymentState, K8sDeploymentStatusSummary } from "./schemas";

const {
  orchestrator: { mcpServerBaseImage },
} = config;

/**
 * Result of processing container environment configuration.
 * Contains both environment variables and mounted secrets information.
 */
interface ContainerEnvResult {
  envVars: k8s.V1EnvVar[];
  mountedSecrets: Array<{ key: string }>;
}

/**
 * Cached nodeSelector from the archestra-platform pod.
 * This is fetched once on first use and reused for all MCP server deployments.
 */
let cachedPlatformNodeSelector: k8s.V1PodSpec["nodeSelector"] | null = null;
let nodeSelectorFetched = false;

/**
 * Type guard to check if an error is a Kubernetes 404 (Not Found) error.
 * K8s client errors can have either `statusCode` or `code` property set to 404.
 */
function isK8s404Error(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (("statusCode" in error && error.statusCode === 404) ||
      ("code" in error && error.code === 404))
  );
}

/**
 * Fetches the nodeSelector from the archestra-platform pod (the pod running the backend).
 * This allows MCP server deployments to inherit the same nodeSelector as the platform,
 * which is useful when targeting specific node pools (e.g., Karpenter nodepools).
 *
 * The result is cached after the first call to avoid repeated API calls.
 *
 * @param k8sApi - The Kubernetes CoreV1Api client
 * @param namespace - The namespace to search for the platform pod
 * @returns The nodeSelector from the platform pod, or null if not found/not configured
 */
export async function fetchPlatformPodNodeSelector(
  k8sApi: k8s.CoreV1Api,
  namespace: string,
): Promise<k8s.V1PodSpec["nodeSelector"] | null> {
  // Return cached value if already fetched
  if (nodeSelectorFetched) {
    return cachedPlatformNodeSelector;
  }

  try {
    // Try to find the current pod by reading the POD_NAME environment variable
    // which is typically set via the Kubernetes downward API.
    // Only attempt this when running inside K8s cluster - otherwise HOSTNAME
    // will be the Docker container ID which won't exist as a K8s pod.
    const podName = config.orchestrator.kubernetes
      .loadKubeconfigFromCurrentCluster
      ? process.env.POD_NAME || process.env.HOSTNAME
      : process.env.POD_NAME;

    if (podName) {
      // Read the current pod's spec directly
      const pod = await k8sApi.readNamespacedPod({
        name: podName,
        namespace,
      });

      cachedPlatformNodeSelector = pod.spec?.nodeSelector || null;
      nodeSelectorFetched = true;

      if (cachedPlatformNodeSelector) {
        logger.info(
          { nodeSelector: cachedPlatformNodeSelector },
          "Fetched nodeSelector from archestra-platform pod",
        );
      } else {
        logger.debug("Archestra-platform pod has no nodeSelector configured");
      }

      return cachedPlatformNodeSelector;
    }

    // Fallback: Search for pods with app.kubernetes.io/name=archestra-platform label
    const pods = await k8sApi.listNamespacedPod({
      namespace,
      labelSelector: "app.kubernetes.io/name=archestra-platform",
    });

    // Get the first running pod's nodeSelector
    const runningPod = pods.items.find(
      (pod) => pod.status?.phase === "Running",
    );

    if (runningPod?.spec?.nodeSelector) {
      cachedPlatformNodeSelector = runningPod.spec.nodeSelector;
      nodeSelectorFetched = true;

      logger.info(
        { nodeSelector: cachedPlatformNodeSelector },
        "Fetched nodeSelector from archestra-platform pod (via label selector)",
      );

      return cachedPlatformNodeSelector;
    }

    // No nodeSelector found
    nodeSelectorFetched = true;
    cachedPlatformNodeSelector = null;

    logger.debug(
      "No archestra-platform pod found or no nodeSelector configured",
    );

    return null;
  } catch (error) {
    // Log the error but don't fail - nodeSelector inheritance is optional
    logger.warn(
      { err: error },
      "Failed to fetch archestra-platform pod nodeSelector, MCP servers will use default scheduling",
    );

    nodeSelectorFetched = true;
    cachedPlatformNodeSelector = null;

    return null;
  }
}

/**
 * Resets the cached platform nodeSelector.
 * This is primarily useful for testing.
 */
export function resetPlatformNodeSelectorCache(): void {
  cachedPlatformNodeSelector = null;
  nodeSelectorFetched = false;
}

/**
 * Returns the cached platform nodeSelector without fetching.
 * This is useful for synchronous access after the initial fetch.
 */
export function getCachedPlatformNodeSelector():
  | k8s.V1PodSpec["nodeSelector"]
  | null {
  return cachedPlatformNodeSelector;
}

/**
 * K8sDeployment manages a single MCP server running as a Kubernetes Deployment.
 */
export default class K8sDeployment {
  private mcpServer: McpServer;
  private k8sApi: k8s.CoreV1Api;
  private k8sAppsApi: k8s.AppsV1Api;
  private k8sAttach: Attach;
  private k8sLog: k8s.Log;
  private defaultNamespace: string;
  private deploymentName: string; // Used for deployment name
  private state: K8sDeploymentState = "not_created";
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
    k8sAppsApi: k8s.AppsV1Api,
    k8sAttach: Attach,
    k8sLog: k8s.Log,
    namespace: string,
    catalogItem?: InternalMcpCatalog | null,
    userConfigValues?: Record<string, string>,
    environmentValues?: Record<string, string>,
  ) {
    this.mcpServer = mcpServer;
    this.k8sApi = k8sApi;
    this.k8sAppsApi = k8sAppsApi;
    this.k8sAttach = k8sAttach;
    this.k8sLog = k8sLog;
    this.defaultNamespace = namespace;
    this.catalogItem = catalogItem;
    this.userConfigValues = userConfigValues;
    this.environmentValues = environmentValues;
    this.deploymentName = K8sDeployment.constructDeploymentName(mcpServer);
  }

  /**
   * Returns the effective namespace for this deployment.
   * Uses the namespace from advancedK8sConfig if specified, otherwise falls back to the default.
   */
  private get namespace(): string {
    return (
      this.catalogItem?.localConfig?.advancedK8sConfig?.namespace ||
      this.defaultNamespace
    );
  }

  /**
   * Constructs a valid Kubernetes deployment name for an MCP server.
   *
   * Creates a deployment name in the format "mcp-<slugified-name>".
   */
  static constructDeploymentName(mcpServer: McpServer): string {
    const slugified = K8sDeployment.ensureStringIsRfc1123Compliant(
      mcpServer.name,
    );
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
   * Sanitizes a single label value to ensure it's RFC 1123 compliant,
   * no longer than 63 characters, and ends with an alphanumeric character.
   */
  static sanitizeLabelValue(value: string): string {
    return K8sDeployment.ensureStringIsRfc1123Compliant(value)
      .substring(0, 63)
      .replace(/[^a-z0-9]+$/, "");
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
      sanitized[K8sDeployment.ensureStringIsRfc1123Compliant(key)] =
        K8sDeployment.sanitizeLabelValue(value);
    }
    return sanitized;
  }

  /**
   * Get catalog item for this MCP server.
   * Caches the result in this.catalogItem for subsequent calls.
   */
  private async getCatalogItem(): Promise<InternalMcpCatalog | null> {
    if (this.catalogItem) {
      return this.catalogItem;
    }

    if (!this.mcpServer.catalogId) {
      return null;
    }

    this.catalogItem = await InternalMcpCatalogModel.findById(
      this.mcpServer.catalogId,
    );
    return this.catalogItem;
  }

  /**
   * Create or update a Kubernetes Secret for environment variables marked as "secret" type
   */
  async createK8sSecret(secretData: Record<string, string>): Promise<void> {
    const k8sSecretName = K8sDeployment.constructK8sSecretName(
      this.mcpServer.id,
    );

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
          labels: K8sDeployment.sanitizeMetadataLabels({
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
    const k8sSecretName = K8sDeployment.constructK8sSecretName(
      this.mcpServer.id,
    );

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
      if (isK8s404Error(error)) {
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
   * Delete the Kubernetes Service for this MCP server (used by HTTP-based servers)
   */
  async deleteK8sService(): Promise<void> {
    const serviceName = `${this.deploymentName}-service`;

    try {
      await this.k8sApi.deleteNamespacedService({
        name: serviceName,
        namespace: this.namespace,
      });

      logger.info(
        {
          mcpServerId: this.mcpServer.id,
          serviceName,
          namespace: this.namespace,
        },
        "Deleted K8s Service for MCP server",
      );
    } catch (error: unknown) {
      // If service doesn't exist (404), that's okay - it may have been deleted already or never created
      if (isK8s404Error(error)) {
        logger.debug(
          {
            mcpServerId: this.mcpServer.id,
            serviceName,
          },
          "K8s Service not found (already deleted or never created)",
        );
        return;
      }

      logger.error(
        {
          err: error,
          mcpServerId: this.mcpServer.id,
          serviceName,
        },
        "Failed to delete K8s Service",
      );
      throw error;
    }
  }

  /**
   * Generate the deployment specification for this MCP server
   *
   * @param dockerImage - The Docker image to use for the container
   * @param localConfig - The local configuration for the MCP server
   * @param needsHttp - Whether the deployment's pod needs HTTP port exposure
   * @param httpPort - The HTTP port to expose (if needsHttp is true)
   * @param nodeSelector - Optional nodeSelector to apply to the pod spec (e.g., inherited from platform pod)
   * @returns The Kubernetes deployment specification
   */
  generateDeploymentSpec(
    dockerImage: string,
    localConfig: z.infer<typeof LocalConfigSchema>,
    needsHttp: boolean,
    httpPort: number,
    nodeSelector?: k8s.V1PodSpec["nodeSelector"] | null,
  ): k8s.V1Deployment {
    const advancedConfig = localConfig.advancedK8sConfig;

    // Labels common to Deployment, RS, and Pods
    // Merge custom labels from advanced config with required labels
    // Required labels are spread last to prevent custom labels from overriding them
    const labels = K8sDeployment.sanitizeMetadataLabels({
      ...(advancedConfig?.labels || {}),
      app: "mcp-server",
      "mcp-server-id": this.mcpServer.id,
      "mcp-server-name": this.mcpServer.name,
    });

    // Get environment variables and mounted secrets
    const { envVars, mountedSecrets } = this.createContainerEnvFromConfig();
    const k8sSecretName = K8sDeployment.constructK8sSecretName(
      this.mcpServer.id,
    );

    // Build volume mounts for mounted secrets (read-only files at /secrets/<key>)
    const volumeMounts: k8s.V1VolumeMount[] = mountedSecrets.map(({ key }) => ({
      name: "mounted-secrets",
      mountPath: `/secrets/${key}`,
      subPath: key,
      readOnly: true,
    }));

    // Build volumes for mounted secrets (single volume with all secret keys)
    const volumes: k8s.V1Volume[] =
      mountedSecrets.length > 0
        ? [
            {
              name: "mounted-secrets",
              secret: {
                secretName: k8sSecretName,
                items: mountedSecrets.map(({ key }) => ({ key, path: key })),
              },
            },
          ]
        : [];

    const podSpec: k8s.V1PodSpec = {
      // Fast shutdown for stateless MCP servers (default is 30s)
      terminationGracePeriodSeconds: 5,
      // Use dedicated service account if specified (value used directly from catalog)
      ...(localConfig.serviceAccount
        ? {
            serviceAccountName: localConfig.serviceAccount,
          }
        : {}),
      // Apply nodeSelector if provided (e.g., inherited from archestra-platform pod)
      ...(nodeSelector && Object.keys(nodeSelector).length > 0
        ? { nodeSelector }
        : {}),
      // Add volumes for mounted secrets
      ...(volumes.length > 0 ? { volumes } : {}),
      containers: [
        {
          name: "mcp-server",
          image: dockerImage,
          // Use Never for local images (without registry/domain prefix)
          // Registry images typically have a domain or slash (e.g., docker.io/image, myregistry.com/image, or username/image)
          imagePullPolicy:
            dockerImage.includes("/") || dockerImage.includes(".")
              ? undefined // Let K8s decide (defaults to Always for :latest, IfNotPresent for others)
              : ("Never" as k8s.V1Container["imagePullPolicy"]), // For local images like "gaggimate-mcp:latest" without registry
          env: envVars,
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
          // Add volume mounts for mounted secrets
          ...(volumeMounts.length > 0 ? { volumeMounts } : {}),
          // Set resource requests/limits for the container (with defaults)
          resources: {
            requests: {
              memory:
                advancedConfig?.resources?.requests?.memory ||
                MCP_ORCHESTRATOR_DEFAULTS.resourceRequestMemory,
              cpu:
                advancedConfig?.resources?.requests?.cpu ||
                MCP_ORCHESTRATOR_DEFAULTS.resourceRequestCpu,
            },
            ...(advancedConfig?.resources?.limits
              ? {
                  limits: {
                    ...(advancedConfig.resources.limits.memory
                      ? { memory: advancedConfig.resources.limits.memory }
                      : {}),
                    ...(advancedConfig.resources.limits.cpu
                      ? { cpu: advancedConfig.resources.limits.cpu }
                      : {}),
                  },
                }
              : {}),
          },
        },
      ],
      restartPolicy: "Always",
    };

    // Build pod template metadata with optional annotations
    const podTemplateMetadata: k8s.V1ObjectMeta = {
      labels,
      ...(advancedConfig?.annotations
        ? { annotations: advancedConfig.annotations }
        : {}),
    };

    return {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: this.deploymentName, // Use the same naming convention for the deployment
        labels,
      },
      spec: {
        replicas:
          advancedConfig?.replicas ?? MCP_ORCHESTRATOR_DEFAULTS.replicas,
        selector: {
          matchLabels: labels,
        },
        template: {
          metadata: podTemplateMetadata,
          spec: podSpec,
        },
      },
    };
  }

  /**
   * Rewrite localhost URLs to host.docker.internal for Docker Desktop Kubernetes.
   * This allows deployment pods to access services running on the host machine.
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
   * Create environment variables for the container
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
   * For secrets marked with "mounted: true", they will be skipped from env vars
   * and instead returned in mountedSecrets array for volume mounting.
   *
   * For Docker Desktop Kubernetes environments, localhost URLs are automatically
   * rewritten to host.docker.internal to allow pods to access services on the host.
   */
  createContainerEnvFromConfig(): ContainerEnvResult {
    const env: k8s.V1EnvVar[] = [];
    const envMap = new Map<string, string>();
    const secretEnvVars = new Set<string>();
    const mountedSecretKeys = new Set<string>();

    // Process all environment variables from catalog
    if (this.catalogItem?.localConfig?.environment) {
      for (const envDef of this.catalogItem.localConfig.environment) {
        // Track secret-type env vars
        if (envDef.type === "secret") {
          secretEnvVars.add(envDef.key);
          // Track mounted secrets (only applicable to secret type)
          if (envDef.mounted) {
            mountedSecretKeys.add(envDef.key);
          }
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

    // Track mounted secrets for volume mounting
    const mountedSecrets: Array<{ key: string }> = [];

    // Convert map to k8s env vars, using conditional logic for secrets
    envMap.forEach((value, key) => {
      // If this is a mounted secret, skip env var injection - will be volume mounted
      if (mountedSecretKeys.has(key)) {
        if (value && value.trim() !== "") {
          mountedSecrets.push({ key });
        }
        return;
      }

      // If this env var is marked as "secret" type, use valueFrom.secretKeyRef
      if (secretEnvVars.has(key)) {
        // Skip secret-type env vars with empty values (no K8s Secret will be created)
        if (!value || value.trim() === "") {
          return;
        }
        const k8sSecretName = K8sDeployment.constructK8sSecretName(
          this.mcpServer.id,
        );
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

    return { envVars: env, mountedSecrets };
  }

  /**
   * Ensure HTTP server configuration (Service and URL) is set up
   */
  private async ensureHttpServerConfigured(): Promise<void> {
    const needsHttp = await this.needsHttpPort();
    if (!needsHttp) {
      return;
    }

    const catalogItem = await this.getCatalogItem();
    const httpPort = catalogItem?.localConfig?.httpPort || 8080;
    const httpPath = catalogItem?.localConfig?.httpPath || "/mcp";

    // Ensure Service exists
    await this.createServiceForHttpServer(httpPort);

    // Resolve HTTP Endpoint URL
    let baseUrl: string;
    if (config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster) {
      // In-cluster: use service DNS name
      const serviceName = `${this.deploymentName}-service`;
      baseUrl = `http://${serviceName}.${this.namespace}.svc.cluster.local:${httpPort}`;
    } else {
      // Local dev: get NodePort from service
      const serviceName = `${this.deploymentName}-service`;
      try {
        const service = await this.k8sApi.readNamespacedService({
          name: serviceName,
          namespace: this.namespace,
        });

        const nodePort = service.spec?.ports?.[0]?.nodePort;
        if (!nodePort) {
          throw new Error(`Service ${serviceName} has no NodePort assigned`);
        }

        baseUrl = `http://localhost:${nodePort}`;
      } catch (error) {
        logger.error(
          { err: error },
          `Could not resolve NodePort for service ${serviceName}`,
        );
        return;
      }
    }

    // Set the endpoint URL
    this.httpEndpointUrl = `${baseUrl}${httpPath}`;

    logger.info(
      `HTTP endpoint URL for ${this.deploymentName}: ${this.httpEndpointUrl}`,
    );
  }

  /**
   * Create or start the deployment for this MCP server
   */
  async startOrCreateDeployment(): Promise<void> {
    try {
      /**
       * MIGRATION STEP:
       * Check if there's a bare pod with the same name.
       * If it exists and is not controlled by a ReplicaSet, delete it.
       */
      try {
        const existingPod = await this.k8sApi.readNamespacedPod({
          name: this.deploymentName,
          namespace: this.namespace,
        });

        // Check if it's a bare pod (no owner references or owner is not a ReplicaSet)
        const isBarePod =
          !existingPod.metadata?.ownerReferences ||
          existingPod.metadata.ownerReferences.length === 0 ||
          !existingPod.metadata.ownerReferences.some(
            (ref) => ref.kind === "ReplicaSet",
          );

        if (isBarePod) {
          logger.info(
            `Found legacy bare pod ${this.deploymentName}, deleting for migration to Deployment`,
          );
          await this.k8sApi.deleteNamespacedPod({
            name: this.deploymentName,
            namespace: this.namespace,
          });
        }
      } catch (error: unknown) {
        // Ignore 404, propagate others
        if (!isK8s404Error(error)) {
          logger.warn(
            { err: error },
            `Error checking for legacy pod ${this.deploymentName}`,
          );
        }
      }

      // Check if deployment already exists
      try {
        const existingDeployment =
          await this.k8sAppsApi.readNamespacedDeployment({
            name: this.deploymentName,
            namespace: this.namespace,
          });

        if (existingDeployment.status?.availableReplicas) {
          this.state = "running";

          // For running deployments, we need to find the pod to assign HTTP port
          const pod = await this.findPodForDeployment();
          if (pod) {
            await this.assignHttpPortIfNeeded(pod);
          }

          // Ensure HTTP configuration is set up
          await this.ensureHttpServerConfigured();

          logger.info(`Deployment ${this.deploymentName} is already running`);
          return;
        }

        // If deployment exists but is not ready, return to let waitForDeploymentReady handle it
        logger.info(
          `Deployment ${this.deploymentName} exists but is not yet ready`,
        );
        this.state = "pending";

        // Even if pending, ensure HTTP configuration (Service + URL) is set up
        await this.ensureHttpServerConfigured();
        return;
      } catch (error: unknown) {
        // Deployment doesn't exist, we'll create it below
        if (!isK8s404Error(error)) {
          throw error;
        }
        // 404 means deployment doesn't exist
      }

      // Get catalog item to get local config
      const catalogItem = await this.getCatalogItem();

      if (!catalogItem?.localConfig) {
        throw new Error(
          `Local config not found for MCP server ${this.mcpServer.name}`,
        );
      }

      // Create new deployment
      logger.info(
        `Creating deployment ${this.deploymentName} for MCP server ${this.mcpServer.name}`,
      );

      this.state = "pending";

      // Use custom Docker image if provided
      const dockerImage =
        catalogItem.localConfig.dockerImage || mcpServerBaseImage;
      logger.info(`Using Docker image: ${dockerImage}`);

      // Check if HTTP port is needed
      const needsHttp = await this.needsHttpPort();
      const httpPort = catalogItem.localConfig.httpPort || 8080;

      // Normalize localConfig to ensure fields have defaults
      const normalizedLocalConfig = {
        ...catalogItem.localConfig,
        environment: catalogItem.localConfig.environment?.map((env) => ({
          ...env,
          required: env.required ?? false,
          description: env.description ?? "",
        })),
      };

      // Get the cached nodeSelector from the platform pod (if available)
      // This allows MCP servers to inherit the same scheduling constraints
      const platformNodeSelector = getCachedPlatformNodeSelector();

      await this.k8sAppsApi.createNamespacedDeployment({
        namespace: this.namespace,
        body: this.generateDeploymentSpec(
          dockerImage,
          normalizedLocalConfig,
          needsHttp,
          httpPort,
          platformNodeSelector,
        ),
      });

      logger.info(`Deployment ${this.deploymentName} created`);

      // Ensure HTTP configuration is set up
      await this.ensureHttpServerConfigured();

      // Note: assignedHttpPort is set asynchronously in findPodForDeployment during status checks
      // State is "pending" until waitForDeploymentReady confirms the deployment has available replicas
      this.state = "pending";
      logger.info(`Deployment ${this.deploymentName} initiated`);
    } catch (error: unknown) {
      this.state = "failed";
      this.errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { err: error },
        `Failed to start deployment ${this.deploymentName}:`,
      );
      throw error;
    }
  }

  /**
   * Helper to find the running pod for this deployment
   */
  private async findPodForDeployment(): Promise<k8s.V1Pod | undefined> {
    try {
      const sanitizedId = K8sDeployment.sanitizeLabelValue(this.mcpServer.id);
      const pods = await this.k8sApi.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `mcp-server-id=${sanitizedId}`,
      });

      // Return the first running pod
      return pods.items.find((pod) => pod.status?.phase === "Running");
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to list pods for ${this.deploymentName}`,
      );
      return undefined;
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
    const serviceName = `${this.deploymentName}-service`;

    try {
      // Check if service already exists
      try {
        await this.k8sApi.readNamespacedService({
          name: serviceName,
          namespace: this.namespace,
        });
        logger.info(`Service ${serviceName} already exists`);
        return;
      } catch (error: unknown) {
        // Service doesn't exist, we'll create it below
        if (!isK8s404Error(error)) {
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
          labels: K8sDeployment.sanitizeMetadataLabels({
            app: "mcp-server",
            "mcp-server-id": this.mcpServer.id,
          }),
        },
        spec: {
          selector: K8sDeployment.sanitizeMetadataLabels({
            app: "mcp-server",
            "mcp-server-id": this.mcpServer.id,
          }),
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

      logger.info(
        `Created service ${serviceName} for deployment ${this.deploymentName}`,
      );
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to create service for deployment ${this.deploymentName}:`,
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
        `Assigned HTTP port ${this.assignedHttpPort} for deployment ${this.deploymentName}`,
      );
    }
  }

  /**
   * Wait for deployment to be in ready state
   */
  async waitForDeploymentReady(
    maxAttempts = 60,
    intervalMs = 2000,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const deployment = await this.k8sAppsApi.readNamespacedDeployment({
          name: this.deploymentName,
          namespace: this.namespace,
        });

        if (
          deployment.status?.availableReplicas &&
          deployment.status.availableReplicas > 0
        ) {
          // Also check if we can find the pod
          const pod = await this.findPodForDeployment();
          if (pod && pod.status?.phase === "Running") {
            await this.assignHttpPortIfNeeded(pod);
            // Update state to running now that deployment is confirmed ready
            this.state = "running";
            return;
          }
        }

        // Check for failures in latest pods
        const sanitizedId = K8sDeployment.sanitizeLabelValue(this.mcpServer.id);
        const pods = await this.k8sApi.listNamespacedPod({
          namespace: this.namespace,
          labelSelector: `mcp-server-id=${sanitizedId}`,
        });

        for (const pod of pods.items) {
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
                    `Deployment ${this.deploymentName} failed: ${waitingReason} - ${message}`,
                  );
                }
              }
            }
          }
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
      `Deployment ${this.deploymentName} did not become ready after ${maxAttempts} attempts`,
    );
  }

  /**
   * Stop the deployment (fire-and-forget - K8s handles cleanup in background)
   */
  async stopDeployment(): Promise<void> {
    try {
      logger.info(`Stopping deployment ${this.deploymentName}`);
      await this.k8sAppsApi.deleteNamespacedDeployment({
        name: this.deploymentName,
        namespace: this.namespace,
      });
      logger.info(`Deployment ${this.deploymentName} deletion initiated`);
      this.state = "not_created";
    } catch (error: unknown) {
      // If deployment doesn't exist (404), that's okay - it may have been deleted already
      if (isK8s404Error(error)) {
        logger.info(`Deployment ${this.deploymentName} already deleted`);
        this.state = "not_created";
        return;
      }
      logger.error(
        { err: error },
        `Failed to stop deployment ${this.deploymentName}:`,
      );
      throw error;
    }
  }

  /**
   * Remove the deployment completely (including associated Service and Secret)
   */
  async removeDeployment(): Promise<void> {
    await this.stopDeployment();
    await this.deleteK8sService();
    await this.deleteK8sSecret();
  }

  /**
   * Get recent logs from the pod
   */
  async getRecentLogs(lines: number = 100): Promise<string> {
    try {
      const pod = await this.findPodForDeployment();
      if (!pod || !pod.metadata?.name) {
        return "Pod not found or not running";
      }

      const logs = await this.k8sApi.readNamespacedPodLog({
        name: pod.metadata.name,
        namespace: this.namespace,
        tailLines: lines,
      });

      return logs || "";
    } catch (error: unknown) {
      logger.error(
        { err: error },
        `Failed to get logs for deployment ${this.deploymentName}:`,
      );

      // If pod doesn't exist (404), return a helpful message
      if (isK8s404Error(error)) {
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
      const pod = await this.findPodForDeployment();
      if (!pod || !pod.metadata?.name) {
        throw new Error("No running pod found for deployment");
      }

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
          `Log stream error for pod ${pod.metadata?.name}:`,
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
          `Response stream error for pod ${pod.metadata?.name}:`,
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
        pod.metadata.name,
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
        `Failed to stream logs for deployment ${this.deploymentName}:`,
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
   * Get the deployment's status summary
   */
  get statusSummary(): K8sDeploymentStatusSummary {
    return {
      state: this.state,
      message:
        this.state === "running"
          ? "Deployment is running"
          : this.state === "pending"
            ? "Deployment is starting"
            : this.state === "failed"
              ? "Deployment failed"
              : "Deployment not created",
      error: this.errorMessage,
      deploymentName: this.deploymentName,
      namespace: this.namespace,
    };
  }

  get containerName(): string {
    // Return the deployment name (label selector will find the pod)
    return this.deploymentName;
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
   * Get the deployment name
   */
  get k8sDeploymentName(): string {
    return this.deploymentName;
  }

  /**
   * Check if this pod uses streamable HTTP transport
   */
  async usesStreamableHttp(): Promise<boolean> {
    return await this.needsHttpPort();
  }

  /**
   * Get the name of the currently running pod for this deployment.
   * Useful for attaching to the pod or streaming logs.
   */
  async getRunningPodName(): Promise<string | undefined> {
    const pod = await this.findPodForDeployment();
    return pod?.metadata?.name;
  }

  /**
   * Get the HTTP endpoint URL for streamable-http servers
   */
  getHttpEndpointUrl(): string | undefined {
    return this.httpEndpointUrl;
  }
}
