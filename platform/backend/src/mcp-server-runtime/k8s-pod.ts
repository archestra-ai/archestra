import type { IncomingMessage } from "node:http";
import { Readable, Writable } from "node:stream";
import type * as k8s from "@kubernetes/client-node";
import type { Attach } from "@kubernetes/client-node";
import type { LocalConfigSchema } from "@shared";
import type { z } from "zod";
import config from "@/config";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import type { InternalMcpCatalog, McpServer } from "@/types";
import type { K8sPodState, K8sPodStatusSummary } from "./schemas";

const {
  kubernetes: { mcpServerBaseImage },
} = config;

/**
 * K8sPod manages a single MCP server running as a Kubernetes pod.
 * This is analogous to PodmanContainer in the desktop app.
 */
export default class K8sPod {
  private mcpServer: McpServer;
  private k8sApi: k8s.CoreV1Api;
  private k8sExec: k8s.Exec;
  private k8sAttach: Attach;
  private namespace: string;
  private podName: string;
  private state: K8sPodState = "not_created";
  private errorMessage: string | null = null;

  // Track assigned port for HTTP-based MCP servers
  assignedHttpPort?: number;

  // Mutex to serialize attach sessions (only one at a time)
  private attachQueue: Promise<void> = Promise.resolve();

  constructor(
    mcpServer: McpServer,
    k8sApi: k8s.CoreV1Api,
    k8sExec: k8s.Exec,
    k8sAttach: Attach,
    namespace: string,
  ) {
    this.mcpServer = mcpServer;
    this.k8sApi = k8sApi;
    this.k8sExec = k8sExec;
    this.k8sAttach = k8sAttach;
    this.namespace = namespace;
    this.podName = `mcp-${mcpServer.id.toLowerCase()}`;
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
   */
  private createPodEnvFromConfig(
    localConfig?: z.infer<typeof LocalConfigSchema>,
  ): k8s.V1EnvVar[] {
    const env: k8s.V1EnvVar[] = [];

    // Add environment variables from local config
    if (localConfig?.environment) {
      Object.entries(localConfig.environment).forEach(([key, value]) => {
        env.push({
          name: key,
          value: String(value),
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
          this.assignHttpPortIfNeeded(existingPod);
          console.log(`Pod ${this.podName} is already running`);
          return;
        }

        // If pod exists but not running, delete and recreate
        if (existingPod.status?.phase === "Failed") {
          console.log(`Deleting failed pod ${this.podName}`);
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
      console.log(
        `Creating pod ${this.podName} for MCP server ${this.mcpServer.name}`,
      );
      console.log(
        `Using command: ${catalogItem.localConfig.command} ${catalogItem.localConfig.arguments.join(" ")}`,
      );
      this.state = "pending";

      const podSpec: k8s.V1Pod = {
        metadata: {
          name: this.podName,
          labels: {
            app: "mcp-server",
            "mcp-server-id": this.mcpServer.id,
            "mcp-server-name": this.mcpServer.name,
          },
        },
        spec: {
          containers: [
            {
              name: "mcp-server",
              image: mcpServerBaseImage,
              env: this.createPodEnvFromConfig(catalogItem.localConfig),
              // Use the command and arguments from local config
              command: [catalogItem.localConfig.command],
              args: catalogItem.localConfig.arguments,
              // For stdio-based MCP servers, we use stdin/stdout
              stdin: true,
              tty: false,
              // For HTTP-based MCP servers, expose port
              ports: this.needsHttpPort()
                ? [
                    {
                      containerPort: 8080,
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

      console.log(`Pod ${this.podName} created, waiting for it to be ready...`);

      // Wait for pod to be ready
      await this.waitForPodReady();

      // Assign HTTP port if needed
      this.assignHttpPortIfNeeded(createdPod);

      this.state = "running";
      console.log(`Pod ${this.podName} is now running`);
    } catch (error: unknown) {
      this.state = "failed";
      this.errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(`Failed to start pod ${this.podName}:`, error);
      throw error;
    }
  }

  /**
   * Check if this MCP server needs an HTTP port
   */
  private needsHttpPort(): boolean {
    // TODO: Load from catalog item to check if streamable_http_url is configured
    // For now, assume all local servers use stdio
    return false;
  }

  /**
   * Assign HTTP port from the pod/service
   */
  private assignHttpPortIfNeeded(pod: k8s.V1Pod): void {
    if (this.needsHttpPort() && pod.status?.podIP) {
      // Use the container port directly with pod IP
      this.assignedHttpPort = 8080;
      console.log(
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
      console.log(`Stopping pod ${this.podName}`);
      await this.k8sApi.deleteNamespacedPod({
        name: this.podName,
        namespace: this.namespace,
      });
      this.state = "not_created";
      console.log(`Pod ${this.podName} stopped`);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("404")) {
        console.error(`Failed to stop pod ${this.podName}:`, error);
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
      console.error(`Failed to stream to pod ${this.podName}:`, error);
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
      console.error(`Failed to get logs for pod ${this.podName}:`, error);
      if (error instanceof Error && error.message.includes("404")) {
        return "Pod not found";
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
}
