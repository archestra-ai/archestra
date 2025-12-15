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
  private k8sAppsApi: k8s.AppsV1Api;
  private k8sAttach: Attach;
  private k8sLog: k8s.Log;
  private namespace: string;
  /**
   * The pod name used for service discovery, service naming, status reporting, and backward compatibility.
   * This name is derived from the MCP server name and is actively used for:
   * - Service resource naming and discovery (e.g., `${podName}-service`)
   * - Constructing service URLs for HTTP-based MCP servers (both in-cluster and local dev)
   * - Status summary reporting
   * - Fallback log retrieval when the deployment pod cannot be found
   * - Backward compatibility when migrating from raw Pods to Deployments
   *
   * Note: This has the same value as `deploymentName` but serves different semantic purposes.
   * The podName is the primary identifier for service discovery and naming, while deploymentName
   * is used for Deployment resource management.
   */
  private podName: string;
  /**
   * The Deployment resource name used for all Kubernetes Deployment operations.
   * This name is used for:
   * - Creating, reading, updating, and deleting Deployment resources
   * - All Deployment-specific API calls
   * - Logging and error messages related to Deployments
   *
   * Note: This has the same value as `podName` but serves different semantic purposes.
   * The Deployment is the primary resource being managed, while podName is maintained
   * for backward compatibility and service naming conventions.
   */
  private deploymentName: string;
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
    this.namespace = namespace;
    this.catalogItem = catalogItem;
    this.userConfigValues = userConfigValues;
    this.environmentValues = environmentValues;
    this.podName = K8sPod.constructPodName(mcpServer);
    // Deployment name uses the same value as podName for consistency, but they serve
    // different semantic purposes (see property documentation above)
    this.deploymentName = this.podName;
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
   * Check if an error is a 404 Not Found error from Kubernetes API
   * Kubernetes client errors can have either statusCode or code property set to 404
   */
  private isNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }
    return (
      ("statusCode" in error && error.statusCode === 404) ||
      ("code" in error && error.code === 404)
    );
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
      if (this.isNotFoundError(error)) {
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
   * Generate the pod template specification for this MCP server
   * This is used within a Deployment's pod template
   *
   * @param dockerImage - The Docker image to use for the container
   * @param localConfig - The local configuration for the MCP server
   * @param needsHttp - Whether the pod needs HTTP port exposure
   * @param httpPort - The HTTP port to expose (if needsHttp is true)
   * @returns The Kubernetes pod template specification
   */
  generatePodTemplateSpec(
    dockerImage: string,
    localConfig: z.infer<typeof LocalConfigSchema>,
    needsHttp: boolean,
    httpPort: number,
  ): k8s.V1PodTemplateSpec {
    const labels = K8sPod.sanitizeMetadataLabels({
      app: "mcp-server",
      "mcp-server-id": this.mcpServer.id,
      "mcp-server-name": this.mcpServer.name,
    });

    return {
      metadata: {
        labels,
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
   * Generate the Deployment specification for this MCP server
   *
   * @param dockerImage - The Docker image to use for the container
   * @param localConfig - The local configuration for the MCP server
   * @param needsHttp - Whether the pod needs HTTP port exposure
   * @param httpPort - The HTTP port to expose (if needsHttp is true)
   * @returns The Kubernetes Deployment specification
   */
  generateDeploymentSpec(
    dockerImage: string,
    localConfig: z.infer<typeof LocalConfigSchema>,
    needsHttp: boolean,
    httpPort: number,
  ): k8s.V1Deployment {
    const labels = K8sPod.sanitizeMetadataLabels({
      app: "mcp-server",
      "mcp-server-id": this.mcpServer.id,
      "mcp-server-name": this.mcpServer.name,
    });

    return {
      metadata: {
        name: this.deploymentName,
        labels,
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: "mcp-server",
            "mcp-server-id": this.mcpServer.id,
          },
        },
        template: this.generatePodTemplateSpec(
          dockerImage,
          localConfig,
          needsHttp,
          httpPort,
        ),
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
   * Compare environment variables from two arrays
   * Returns true if they are different
   */
  private envVarsDiffer(
    existing: k8s.V1EnvVar[] | undefined,
    desired: k8s.V1EnvVar[],
  ): boolean {
    if (!existing || existing.length !== desired.length) {
      return true;
    }

    // Create maps for easier comparison
    const existingMap = new Map<string, k8s.V1EnvVar>();
    for (const env of existing) {
      if (env.name) {
        existingMap.set(env.name, env);
      }
    }

    const desiredMap = new Map<string, k8s.V1EnvVar>();
    for (const env of desired) {
      if (env.name) {
        desiredMap.set(env.name, env);
      }
    }

    // Check if all desired env vars exist and match
    for (const [name, desiredEnv] of desiredMap) {
      const existingEnv = existingMap.get(name);
      if (!existingEnv) {
        return true; // Missing env var
      }

      // Compare environment variable values
      // An env var can use either `value` (direct) or `valueFrom` (secret reference)
      // They are different if one uses value and the other uses valueFrom

      const desiredUsesValue = desiredEnv.value !== undefined;
      const existingUsesValue = existingEnv.value !== undefined;
      const desiredUsesValueFrom = desiredEnv.valueFrom !== undefined;
      const existingUsesValueFrom = existingEnv.valueFrom !== undefined;

      // If one uses value and the other uses valueFrom, they're different
      if (desiredUsesValue !== existingUsesValue || desiredUsesValueFrom !== existingUsesValueFrom) {
        return true;
      }

      // Both use value - compare the values
      if (desiredUsesValue && existingUsesValue) {
        if (desiredEnv.value !== existingEnv.value) {
          return true;
        }
      }

      // Both use valueFrom - compare the secret references
      if (desiredUsesValueFrom && existingUsesValueFrom) {
        const desiredRef = desiredEnv.valueFrom?.secretKeyRef;
        const existingRef = existingEnv.valueFrom?.secretKeyRef;
        if (
          desiredRef?.name !== existingRef?.name ||
          desiredRef?.key !== existingRef?.key
        ) {
          return true;
        }
      }

      // If neither value nor valueFrom is defined for both env vars, treat as different (invalid spec)
      if (
        !desiredUsesValue && !existingUsesValue &&
        !desiredUsesValueFrom && !existingUsesValueFrom
      ) {
        return true;
      }
    }

    // Check if any existing env vars are missing in desired
    for (const name of existingMap.keys()) {
      if (!desiredMap.has(name)) {
        return true; // Extra env var in existing
      }
    }

    return false;
  }

  /**
   * Compare arrays for equality using shallow comparison.
   *
   * This function uses strict equality (===) to compare array elements, which works
   * correctly for primitive types (strings, numbers, booleans) but will NOT work
   * correctly for objects or nested arrays.
   *
   * This function is specifically designed for comparing Kubernetes container
   * command and args arrays, which contain only string primitives.
   *
   * @param a - First array to compare (or undefined)
   * @param b - Second array to compare (or undefined)
   * @returns true if arrays are equal (both undefined, or same length with equal primitive values)
   */
  private arraysEqual<
    T extends string | number | boolean | null | undefined,
  >(a: T[] | undefined, b: T[] | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    return a.every((val, idx) => val === b[idx]);
  }

  /**
   * Preserve Kubernetes-managed keys from existing metadata while merging with desired metadata.
   *
   * Kubernetes-managed keys (those starting with "kubernetes.io/" or "app.kubernetes.io/")
   * are preserved from the existing metadata, while all other keys from the desired metadata
   * take precedence. This ensures that Kubernetes-managed annotations and labels are not lost
   * during Deployment updates.
   *
   * @param existing - Existing metadata (annotations or labels) to preserve managed keys from
   * @param desired - Desired metadata (annotations or labels) that takes precedence
   * @returns Merged metadata with Kubernetes-managed keys preserved and desired keys applied
   */
  private static preserveManagedKeys(
    existing: Record<string, string> | undefined,
    desired: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!existing && !desired) return undefined;
    const managedPrefixes = ["kubernetes.io/", "app.kubernetes.io/"];
    const preserved: Record<string, string> = {};
    if (existing) {
      for (const [key, value] of Object.entries(existing)) {
        if (managedPrefixes.some((prefix) => key.startsWith(prefix))) {
          preserved[key] = value;
        }
      }
    }
    // Desired always takes precedence
    return { ...preserved, ...(desired || {}) };
  }

  /**
   * Check if a Deployment needs to be updated by comparing existing vs desired specs
   */
  private deploymentNeedsUpdate(
    existingDeployment: k8s.V1Deployment,
    desiredSpec: k8s.V1Deployment,
  ): boolean {
    const existingContainer =
      existingDeployment.spec?.template.spec?.containers?.[0];
    const desiredContainer = desiredSpec.spec?.template.spec?.containers?.[0];

    if (!existingContainer || !desiredContainer) {
      return true; // If containers are missing, update is needed
    }

    // Compare Docker image
    if (existingContainer.image !== desiredContainer.image) {
      logger.info(
        `Deployment ${this.deploymentName} needs update: image changed from ${existingContainer.image} to ${desiredContainer.image}`,
      );
      return true;
    }

    // Compare command
    if (!this.arraysEqual(existingContainer.command, desiredContainer.command)) {
      logger.info(
        `Deployment ${this.deploymentName} needs update: command changed`,
      );
      return true;
    }

    // Compare arguments
    if (!this.arraysEqual(existingContainer.args, desiredContainer.args)) {
      logger.info(
        `Deployment ${this.deploymentName} needs update: arguments changed`,
      );
      return true;
    }

    // Compare environment variables
    const existingEnv = existingContainer.env || [];
    const desiredEnv = desiredContainer.env || [];
    if (this.envVarsDiffer(existingEnv, desiredEnv)) {
      logger.info(
        `Deployment ${this.deploymentName} needs update: environment variables changed`,
      );
      return true;
    }

    // Compare ports
    const existingPorts = existingContainer.ports || [];
    const desiredPorts = desiredContainer.ports || [];
    if (existingPorts.length !== desiredPorts.length) {
      logger.info(
        `Deployment ${this.deploymentName} needs update: ports changed`,
      );
      return true;
    }
    for (let i = 0; i < existingPorts.length; i++) {
      if (
        existingPorts[i]?.containerPort !== desiredPorts[i]?.containerPort ||
        existingPorts[i]?.protocol !== desiredPorts[i]?.protocol
      ) {
        logger.info(
          `Deployment ${this.deploymentName} needs update: ports changed`,
        );
        return true;
      }
    }

    // Compare service account name
    const existingServiceAccount =
      existingDeployment.spec?.template.spec?.serviceAccountName;
    const desiredServiceAccount =
      desiredSpec.spec?.template.spec?.serviceAccountName;
    if (existingServiceAccount !== desiredServiceAccount) {
      logger.info(
        `Deployment ${this.deploymentName} needs update: serviceAccountName changed from ${existingServiceAccount} to ${desiredServiceAccount}`,
      );
      return true;
    }

    // Compare replica count
    const existingReplicas = existingDeployment.spec?.replicas ?? 1;
    const desiredReplicas = desiredSpec.spec?.replicas ?? 1;
    if (existingReplicas !== desiredReplicas) {
      logger.info(
        `Deployment ${this.deploymentName} needs update: replicas changed from ${existingReplicas} to ${desiredReplicas}`,
      );
      return true;
    }

    return false;
  }

  /**
   * Migrate an existing Pod to a Deployment
   * This handles the migration case where a deployment that already has raw Pods
   * gets upgraded to having Deployments
   *
   * To avoid race conditions and port conflicts (especially for HTTP servers),
   * we delete the old pod BEFORE creating the deployment. This ensures:
   * - No overlap between old and new pods
   * - No port conflicts during migration
   * - Minimal downtime (deployment is created immediately after pod deletion)
   */
  private async migratePodToDeployment(): Promise<void> {
    try {
      // Check if a raw pod exists
      await this.k8sApi.readNamespacedPod({
        name: this.podName,
        namespace: this.namespace,
      });

      logger.info(
        `Migrating existing pod ${this.podName} to Deployment ${this.deploymentName}`,
      );

      // Get catalog item to get local config
      const catalogItem = await this.getCatalogItem();
      if (!catalogItem?.localConfig) {
        throw new Error(
          `Local config not found for MCP server ${this.mcpServer.name}`,
        );
      }

      // Use custom Docker image if provided, otherwise use the base image
      const dockerImage =
        catalogItem.localConfig.dockerImage || mcpServerBaseImage;

      // Check if HTTP port is needed
      const needsHttp = await this.needsHttpPort();
      const httpPort = catalogItem.localConfig.httpPort || 8080;

      // Normalize localConfig
      const normalizedLocalConfig = {
        ...catalogItem.localConfig,
        environment: catalogItem.localConfig.environment?.map((env) => ({
          ...env,
          required: env.required ?? false,
          description: env.description ?? "",
        })),
      };

      // Delete the old pod FIRST to avoid race conditions and port conflicts
      // This ensures the old pod is gone before the deployment creates its new pod
      logger.info(
        `Deleting old pod ${this.podName} before creating Deployment to avoid conflicts`,
      );
      try {
        await this.k8sApi.deleteNamespacedPod({
          name: this.podName,
          namespace: this.namespace,
        });
        logger.info(`Deleted old pod ${this.podName} before migration`);
      } catch (error: unknown) {
        // Pod might have been deleted already
        if (!this.isNotFoundError(error)) {
          logger.warn(
            { err: error },
            `Failed to delete old pod ${this.podName} before migration (non-fatal, continuing)`,
          );
        } else {
          logger.info(`Old pod ${this.podName} already deleted`);
        }
      }

      // Create the Deployment (old pod is now deleted, so no conflicts)
      await this.k8sAppsApi.createNamespacedDeployment({
        namespace: this.namespace,
        body: this.generateDeploymentSpec(
          dockerImage,
          normalizedLocalConfig,
          needsHttp,
          httpPort,
        ),
      });

      logger.info(
        `Created Deployment ${this.deploymentName} for migration from pod ${this.podName}`,
      );

      // Wait for Deployment to be ready
      await this.waitForDeploymentReady();
    } catch (error: unknown) {
      if (!this.isNotFoundError(error)) {
        logger.error(
          { err: error },
          `Failed to migrate pod ${this.podName} to Deployment:`,
        );
        throw error;
      }
      // Pod doesn't exist, nothing to migrate
    }
  }

  /**
   * Create or start the Deployment for this MCP server
   */
  async startOrCreatePod(): Promise<void> {
    try {
      // Get catalog item and config first (needed for comparison)
      const catalogItem = await this.getCatalogItem();
      if (!catalogItem?.localConfig) {
        throw new Error(
          `Local config not found for MCP server ${this.mcpServer.name}`,
        );
      }

      // Use custom Docker image if provided, otherwise use the base image
      const dockerImage =
        catalogItem.localConfig.dockerImage || mcpServerBaseImage;

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

      // Generate desired Deployment spec for comparison
      const desiredDeploymentSpec = this.generateDeploymentSpec(
        dockerImage,
        normalizedLocalConfig,
        needsHttp,
        httpPort,
      );

      // First, check if Deployment already exists
      try {
        const existingDeployment =
          await this.k8sAppsApi.readNamespacedDeployment({
            name: this.deploymentName,
            namespace: this.namespace,
          });

        // Check if Deployment needs updating
        if (this.deploymentNeedsUpdate(existingDeployment, desiredDeploymentSpec)) {
          logger.info(
            `Deployment ${this.deploymentName} needs update, applying changes`,
          );

          // Update the Deployment by replacing it
          // Preserve metadata and resourceVersion for proper update
          const updatedDeployment: k8s.V1Deployment = {
            ...desiredDeploymentSpec,
            metadata: {
              ...desiredDeploymentSpec.metadata,
              resourceVersion: existingDeployment.metadata?.resourceVersion,
              annotations: K8sPod.preserveManagedKeys(
                existingDeployment.metadata?.annotations,
                desiredDeploymentSpec.metadata?.annotations
              ),
              labels: K8sPod.preserveManagedKeys(
                existingDeployment.metadata?.labels,
                desiredDeploymentSpec.metadata?.labels
              ),
            },
          };

          await this.k8sAppsApi.replaceNamespacedDeployment({
            name: this.deploymentName,
            namespace: this.namespace,
            body: updatedDeployment,
          });

          logger.info(
            `Deployment ${this.deploymentName} updated, waiting for rolling update to complete`,
          );

          // Wait for Deployment to be ready after update
          await this.waitForDeploymentReady();
          this.state = "running";
          await this.assignHttpPortFromDeployment();

          if (needsHttp) {
            await this.setHttpEndpointUrlFromService();
          }

          logger.info(
            `Deployment ${this.deploymentName} update complete and ready`,
          );
          return;
        }

        // Deployment exists and doesn't need updating, check if it's ready
        if (
          existingDeployment.status?.readyReplicas === 1 &&
          existingDeployment.status?.replicas === 1
        ) {
          this.state = "running";
          await this.assignHttpPortFromDeployment();

          // Set HTTP endpoint URL if this is an HTTP server
          if (needsHttp) {
            await this.setHttpEndpointUrlFromService();
          }

          logger.info(
            `Deployment ${this.deploymentName} is already running with current configuration`,
          );
          return;
        }

        // Deployment exists but not ready, wait for it
        logger.info(
          `Deployment ${this.deploymentName} exists but not ready, waiting...`,
        );
        await this.waitForDeploymentReady();
        this.state = "running";
        await this.assignHttpPortFromDeployment();

        if (await this.needsHttpPort()) {
          await this.setHttpEndpointUrlFromService();
        }

        logger.info(`Deployment ${this.deploymentName} is now ready`);
        return;
        // biome-ignore lint/suspicious/noExplicitAny: k8s error handling
      } catch (error: any) {
        // Deployment doesn't exist, check if we need to migrate from a Pod
        if (!this.isNotFoundError(error)) {
          throw error;
        }
        // 404 means Deployment doesn't exist, check for old Pod to migrate
      }

      // Check if there's an old Pod that needs migration
      try {
        const existingPod = await this.k8sApi.readNamespacedPod({
          name: this.podName,
          namespace: this.namespace,
        });

        // Pod exists - migrate it to Deployment
        if (existingPod.status?.phase === "Running") {
          logger.info(
            `Found existing pod ${this.podName}, migrating to Deployment`,
          );
          await this.migratePodToDeployment();
          this.state = "running";
          await this.assignHttpPortFromDeployment();

          if (await this.needsHttpPort()) {
            await this.setHttpEndpointUrlFromService();
          }

          logger.info(
            `Successfully migrated pod ${this.podName} to Deployment ${this.deploymentName}`,
          );
          return;
        }

        // If pod exists but not running, delete it and create Deployment
        if (existingPod.status?.phase === "Failed") {
          logger.info(`Deleting failed pod ${this.podName}`);
          try {
            await this.k8sApi.deleteNamespacedPod({
              name: this.podName,
              namespace: this.namespace,
            });
          } catch (deleteError) {
            // Ignore errors deleting failed pod
            logger.warn(
              { err: deleteError },
              `Failed to delete failed pod ${this.podName} (non-fatal)`,
            );
          }
        }
        // biome-ignore lint/suspicious/noExplicitAny: k8s error handling
      } catch (error: any) {
        // Pod doesn't exist, we'll create Deployment below
        if (!this.isNotFoundError(error)) {
          throw error;
        }
        // 404 means pod doesn't exist, which is fine - we'll create Deployment
      }

      // Create new Deployment (catalogItem and config already fetched above)
      logger.info(
        `Creating Deployment ${this.deploymentName} for MCP server ${this.mcpServer.name}`,
      );
      if (catalogItem.localConfig.command) {
        logger.info(
          `Using command: ${catalogItem.localConfig.command} ${(catalogItem.localConfig.arguments || []).join(" ")}`,
        );
      } else {
        logger.info("Using Docker image's default CMD");
      }
      this.state = "pending";

      logger.info(`Using Docker image: ${dockerImage}`);

      await this.k8sAppsApi.createNamespacedDeployment({
        namespace: this.namespace,
        body: desiredDeploymentSpec,
      });

      logger.info(
        `Deployment ${this.deploymentName} created, waiting for it to be ready`,
      );

      // Wait for Deployment to be ready
      await this.waitForDeploymentReady();

      // For HTTP servers, create a K8s Service and set endpoint URL
      if (needsHttp) {
        await this.createServiceForHttpServer(httpPort);
        await this.setHttpEndpointUrlFromService();
      }

      // Assign HTTP port if needed
      await this.assignHttpPortFromDeployment();

      this.state = "running";
      logger.info(`Deployment ${this.deploymentName} is now running`);
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
        if (!this.isNotFoundError(error)) {
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
   * Wait for Deployment to be ready
   */
  private async waitForDeploymentReady(
    maxAttempts = 60,
    intervalMs = 2000,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const deployment =
          await this.k8sAppsApi.readNamespacedDeployment({
            name: this.deploymentName,
            namespace: this.namespace,
          });

        if (
          deployment.status?.readyReplicas === 1 &&
          deployment.status?.replicas === 1 &&
          deployment.status?.conditions?.some(
            (condition) =>
              condition.type === "Available" && condition.status === "True",
          )
        ) {
          return;
        }

        // Check for failure conditions
        // 1. Check for ReplicaFailure condition (indicates pod creation/replica issues)
        const replicaFailure = deployment.status?.conditions?.find(
          (condition) =>
            condition.type === "ReplicaFailure" && condition.status === "True",
        );
        if (replicaFailure) {
          this.state = "failed";
          this.errorMessage =
            replicaFailure.message || "Deployment replica failure";
          throw new Error(
            `Deployment ${this.deploymentName} failed: ${replicaFailure.message || "Replica failure detected"}`,
          );
        }

        // 2. Check for Progressing condition with ProgressDeadlineExceeded (stuck deployment)
        const progressingCondition = deployment.status?.conditions?.find(
          (condition) => condition.type === "Progressing",
        );
        if (
          progressingCondition?.status === "False" ||
          progressingCondition?.reason === "ProgressDeadlineExceeded"
        ) {
          this.state = "failed";
          this.errorMessage =
            progressingCondition.message ||
            "Deployment progress deadline exceeded";
          throw new Error(
            `Deployment ${this.deploymentName} failed: ${progressingCondition.message || "Progress deadline exceeded"}`,
          );
        }

        // 3. Check for Available condition being False (deployment not available)
        const availableCondition = deployment.status?.conditions?.find(
          (condition) => condition.type === "Available",
        );
        if (availableCondition?.status === "False") {
          this.state = "failed";
          this.errorMessage =
            availableCondition.message || "Deployment not available";
          throw new Error(
            `Deployment ${this.deploymentName} failed: ${availableCondition.message || "Deployment not available"}`,
          );
        }
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          (error.message.includes("failed") ||
            error.message.includes("Failed"))
        ) {
          throw error;
        }
        // Continue waiting for other errors
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `Deployment ${this.deploymentName} did not become ready after ${maxAttempts} attempts`,
    );
  }

  /**
   * Get the pod managed by the Deployment
   */
  private async getDeploymentPod(): Promise<k8s.V1Pod | null> {
    try {
      // List pods with the deployment's labels
      const labels = `app=mcp-server,mcp-server-id=${this.mcpServer.id}`;
      const pods = await this.k8sApi.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: labels,
      });

      // For each pod, check if its ReplicaSet owner is owned by our Deployment
      for (const pod of pods.items) {
        const ownerRef = pod.metadata?.ownerReferences?.find(
          (ref) => ref.kind === "ReplicaSet" && !!ref.name
        );
        if (ownerRef && ownerRef.name) {
          try {
            const rs = await this.k8sAppsApi.readNamespacedReplicaSet({
              name: ownerRef.name,
              namespace: this.namespace,
            });
            const rsOwner = rs.metadata?.ownerReferences?.find(
              (ref: k8s.V1OwnerReference) =>
                ref.kind === "Deployment" && ref.name === this.deploymentName,
            );
            if (rsOwner) {
              return pod;
            }
          } catch (err) {
            // Ignore 404 errors for ReplicaSets that may have been deleted
            if (this.isNotFoundError(err)) {
              continue;
            }
            // Re-throw other errors (e.g., network issues) to properly signal failures
            throw err;
          }
        }
      }
      return null;
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to get pod for Deployment ${this.deploymentName}`,
      );
      return null;
    }
  }

  /**
   * Assign HTTP port from the Deployment's pod
   */
  private async assignHttpPortFromDeployment(): Promise<void> {
    const needsHttp = await this.needsHttpPort();
    if (needsHttp) {
      const pod = await this.getDeploymentPod();
      if (pod?.status?.podIP) {
        const catalogItem = await this.getCatalogItem();
        const httpPort = catalogItem?.localConfig?.httpPort || 8080;
        this.assignedHttpPort = httpPort;
        logger.info(
          `Assigned HTTP port ${this.assignedHttpPort} for Deployment ${this.deploymentName}`,
        );
      }
    }
  }

  /**
   * Set HTTP endpoint URL from the service
   */
  private async setHttpEndpointUrlFromService(): Promise<void> {
    const catalogItem = await this.getCatalogItem();
    const httpPort = catalogItem?.localConfig?.httpPort || 8080;
    const httpPath = catalogItem?.localConfig?.httpPath || "/mcp";

    // Use service DNS for in-cluster, localhost with NodePort for local dev
    let baseUrl: string | undefined;
    if (config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster) {
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
          `Could not read service ${serviceName} for Deployment`,
        );
      }
    }

    if (baseUrl) {
      this.httpEndpointUrl = `${baseUrl}${httpPath}`;
      logger.info(
        `HTTP endpoint URL for ${this.deploymentName}: ${this.httpEndpointUrl}`,
      );
    }
  }

  /**
   * Wait for pod to be in running state (now waits for Deployment)
   */
  async waitForPodReady(maxAttempts = 60, intervalMs = 2000): Promise<void> {
    // Use the Deployment readiness check
    await this.waitForDeploymentReady(maxAttempts, intervalMs);
  }

  /**
   * Stop the Deployment (and its pods)
   */
  async stopPod(): Promise<void> {
    try {
      logger.info(`Stopping Deployment ${this.deploymentName}`);

      // First try to delete the Deployment
      try {
        await this.k8sAppsApi.deleteNamespacedDeployment({
          name: this.deploymentName,
          namespace: this.namespace,
        });
      } catch (error: unknown) {
        if (this.isNotFoundError(error)) {
          // Deployment doesn't exist, check for old pod
          logger.info(
            `Deployment ${this.deploymentName} doesn't exist, checking for old pod`,
          );
          try {
            await this.k8sApi.deleteNamespacedPod({
              name: this.podName,
              namespace: this.namespace,
            });
          } catch (podError: unknown) {
            if (this.isNotFoundError(podError)) {
              logger.info(`Pod ${this.podName} already deleted`);
              this.state = "not_created";
              return;
            }
            throw podError;
          }
          this.state = "not_created";
          return;
        }
        throw error;
      }

      // Wait for Deployment to be deleted (up to 30 seconds)
      const maxWaitTime = 30000; // 30 seconds
      const pollInterval = 1000; // 1 second
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        try {
          // Try to get the Deployment - if it doesn't exist, we're done
          await this.k8sAppsApi.readNamespacedDeployment({
            name: this.deploymentName,
            namespace: this.namespace,
          });
          // Deployment still exists, wait and retry
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        } catch (error: unknown) {
          // Deployment not found (404) means it's been deleted
          if (this.isNotFoundError(error)) {
            logger.info(
              `Deployment ${this.deploymentName} successfully terminated`,
            );
            this.state = "not_created";
            return;
          }
          // Other errors, rethrow
          throw error;
        }
      }

      // Timeout reached but Deployment still exists
      logger.warn(
        `Deployment ${this.deploymentName} deletion timeout after ${maxWaitTime}ms, may still be terminating`,
      );
      throw new Error(
        `Deployment ${this.deploymentName} deletion timed out after ${maxWaitTime}ms; resource may still be terminating`
      );
    } catch (error: unknown) {
      if (this.isNotFoundError(error)) {
        // Deployment already doesn't exist, that's fine
        logger.info(`Deployment ${this.deploymentName} already deleted`);
        this.state = "not_created";
        return;
      }
      logger.error(
        { err: error },
        `Failed to stop Deployment ${this.deploymentName}:`,
      );
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
   * Get recent logs from the pod managed by the Deployment
   */
  async getRecentLogs(lines: number = 100): Promise<string> {
    try {
      // Get the pod managed by the Deployment
      const pod = await this.getDeploymentPod();
      if (!pod || !pod.metadata?.name) {
        // Fallback: try to get logs using pod name (for backward compatibility)
        logger.warn(
          {
            mcpServerId: this.mcpServer.id,
            podName: this.podName,
            deploymentName: this.deploymentName,
          },
          "Using fallback to get logs by pod name directly. This may return logs from an old Pod during migrations if the Deployment has already created a new Pod.",
        );
        try {
          const logs = await this.k8sApi.readNamespacedPodLog({
            name: this.podName,
            namespace: this.namespace,
            tailLines: lines,
          });
          return logs || "";
        } catch (fallbackError: unknown) {
          if (this.isNotFoundError(fallbackError)) {
            return "Pod not found";
          }
          throw fallbackError;
        }
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
        `Failed to get logs for Deployment ${this.deploymentName}:`,
      );
      if (this.isNotFoundError(error)) {
        return "Pod not found";
      }
      throw error;
    }
  }

  /**
   * Stream logs from the pod managed by the Deployment with follow enabled
   */
  async streamLogs(
    responseStream: NodeJS.WritableStream,
    lines: number = 100,
  ): Promise<void> {
    try {
      // Get the pod managed by the Deployment
      const pod = await this.getDeploymentPod();
      const podName = pod?.metadata?.name || this.podName; // Fallback to pod name

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
          `Log stream error for Deployment ${this.deploymentName}:`,
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
          `Response stream error for Deployment ${this.deploymentName}:`,
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
        podName,
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
        `Failed to stream logs for Deployment ${this.deploymentName}:`,
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
