import type { IncomingMessage } from "node:http";
import { PassThrough, Readable, Writable } from "node:stream";
import type * as k8s from "@kubernetes/client-node";
import type { Attach } from "@kubernetes/client-node";
import type { LocalConfigSchema } from "@shared";
import type { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
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

  // Track assigned port for HTTP-based MCP servers
  assignedHttpPort?: number;
  // Track the HTTP endpoint URL for streamable-http servers
  httpEndpointUrl?: string;

  // Mutex to serialize attach sessions (only one at a time)
  private attachQueue: Promise<void> = Promise.resolve();

  constructor(
    mcpServer: McpServer,
    k8sApi: k8s.CoreV1Api,
    k8sAttach: Attach,
    k8sLog: k8s.Log,
    namespace: string,
  ) {
    this.mcpServer = mcpServer;
    this.k8sApi = k8sApi;
    this.k8sAttach = k8sAttach;
    this.k8sLog = k8sLog;
    this.namespace = namespace;
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
   */
  static sanitizeMetadataLabels(
    labels: Record<string, string>,
  ): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(labels)) {
      sanitized[K8sPod.ensureStringIsRfc1123Compliant(key)] =
        K8sPod.ensureStringIsRfc1123Compliant(value);
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
   * Create environment variables for the pod
   *
   * This method processes environment variables from the local config and ensures
   * that values are properly formatted. It strips surrounding quotes (both single
   * and double) from values, as they are often used as delimiters in the UI but
   * should not be part of the actual environment variable value.
   */
  static createPodEnvFromConfig(
    localConfig?: z.infer<typeof LocalConfigSchema>,
  ): k8s.V1EnvVar[] {
    const env: k8s.V1EnvVar[] = [];

    // Add environment variables from local config
    if (localConfig?.environment) {
      Object.entries(localConfig.environment).forEach(([key, value]) => {
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

        env.push({
          name: key,
          value: processedValue,
        });
      });
    }

    // TODO: Load OAuth tokens and user config from secrets

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

      const podSpec: k8s.V1Pod = {
        metadata: {
          name: this.podName,
          labels: K8sPod.sanitizeMetadataLabels({
            app: "mcp-server",
            "mcp-server-id": this.mcpServer.id,
            "mcp-server-name": this.mcpServer.name,
          }),
        },
        spec: {
          containers: [
            {
              name: "mcp-server",
              image: dockerImage,
              env: K8sPod.createPodEnvFromConfig(catalogItem.localConfig),
              // Use the command and arguments from local config if provided
              // If not provided, Kubernetes will use the Docker image's default CMD
              ...(catalogItem.localConfig.command
                ? {
                    command: [catalogItem.localConfig.command],
                    args: catalogItem.localConfig.arguments || [],
                  }
                : {}),
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
            },
          ],
          restartPolicy: "Always",
        },
      };

      const createdPod = await this.k8sApi.createNamespacedPod({
        namespace: this.namespace,
        body: podSpec,
      });

      logger.info(`Pod ${this.podName} created, waiting for it to be ready...`);

      // Wait for pod to be ready
      await this.waitForPodReady();

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
  private async waitForPodReady(
    maxAttempts = 60,
    intervalMs = 2000,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const pod = await this.k8sApi.readNamespacedPod({
          name: this.podName,
          namespace: this.namespace,
        });

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
          throw new Error(`Pod ${this.podName} failed to start`);
        }
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message.includes("failed to start")
        ) {
          throw error;
        }
        // Continue waiting for other errors
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `Pod ${this.podName} did not become ready after ${maxAttempts} attempts`,
    );
  }

  /**
   * Stop the pod
   */
  async stopPod(): Promise<void> {
    try {
      logger.info(`Stopping pod ${this.podName}`);
      await this.k8sApi.deleteNamespacedPod({
        name: this.podName,
        namespace: this.namespace,
      });
      this.state = "not_created";
      logger.info(`Pod ${this.podName} stopped`);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("404")) {
        logger.error({ err: error }, `Failed to stop pod ${this.podName}:`);
        throw error;
      }
      // Pod doesn't exist, that's fine
      this.state = "not_created";
    }
  }

  /**
   * Remove the pod completely
   */
  async removePod(): Promise<void> {
    await this.stopPod();
  }

  /**
   * Stream data to/from the pod (for stdio-based MCP servers)
   */
  async streamToPod(
    request: unknown,
    responseStream: IncomingMessage,
  ): Promise<void> {
    // Serialize attach sessions using a queue to prevent concurrent sessions
    // (kubectl attach doesn't support multiple simultaneous sessions to the same pod)
    const result = new Promise<void>((resolveOuter, rejectOuter) => {
      this.attachQueue = this.attachQueue.then(async () => {
        try {
          await this.doStreamToPod(request, responseStream);
          resolveOuter();
        } catch (error) {
          rejectOuter(error);
        }
      });
    });

    return result;
  }

  /**
   * Internal method to stream data to/from the pod
   */
  private async doStreamToPod(
    request: unknown,
    responseStream: IncomingMessage,
  ): Promise<void> {
    try {
      // Use attach to connect to the main MCP server process stdin/stdout
      // This allows us to send JSON-RPC requests and receive responses

      return new Promise((resolve, reject) => {
        let responseData = "";
        let isResolved = false;

        // Create a readable stream for stdin
        const stdinStream = new Readable({
          read() {
            // This will be called when data is needed
          },
        });

        // Create a writable stream for stdout that collects the response
        const stdoutStream = new Writable({
          write(chunk, _encoding, callback) {
            responseData += chunk.toString();

            // MCP JSON-RPC responses are newline-delimited
            // Check if we have a complete JSON response
            if (responseData.includes("\n")) {
              const lines = responseData.split("\n");
              for (const line of lines) {
                if (line.trim()) {
                  try {
                    // Try to parse as JSON to verify it's a complete response
                    JSON.parse(line);
                    // Write the response to the HTTP response stream
                    // biome-ignore lint/suspicious/noExplicitAny: TODO: fix this type..
                    (responseStream as any).write(line);
                    // biome-ignore lint/suspicious/noExplicitAny: TODO: fix this type..
                    (responseStream as any).end();
                    if (!isResolved) {
                      isResolved = true;
                      resolve();
                    }
                    return callback();
                  } catch (_e) {
                    // Not valid JSON yet, continue accumulating
                  }
                }
              }
            }
            callback();
          },
          final(callback) {
            if (!isResolved) {
              // biome-ignore lint/suspicious/noExplicitAny: TODO: fix this type..
              (responseStream as any).end();
              isResolved = true;
              resolve();
            }
            callback();
          },
        });

        // Handle errors
        stdoutStream.on("error", (error) => {
          if (!isResolved) {
            isResolved = true;
            reject(error);
          }
        });

        stdinStream.on("error", (error) => {
          if (!isResolved) {
            isResolved = true;
            reject(error);
          }
        });

        // Attach to the pod's main process
        this.k8sAttach
          .attach(
            this.namespace,
            this.podName,
            "mcp-server",
            stdoutStream,
            null, // stderr - not needed for MCP JSON-RPC
            stdinStream,
            false /* tty */,
          )
          .then((ws) => {
            // Send the JSON-RPC request to the MCP server's stdin
            const requestJson = `${JSON.stringify(request)}\n`;
            stdinStream.push(requestJson);

            // Set a timeout to close the connection if no response
            setTimeout(() => {
              if (!isResolved) {
                isResolved = true;
                ws.close();
                reject(new Error("Timeout waiting for MCP server response"));
              }
            }, 30000); // 30 second timeout
          })
          .catch((error) => {
            if (!isResolved) {
              isResolved = true;
              reject(error);
            }
          });
      });
    } catch (error) {
      logger.error({ err: error }, `Failed to stream to pod ${this.podName}:`);
      throw error;
    }
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
