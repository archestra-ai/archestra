import type { IncomingMessage } from "node:http";
import type * as k8s from "@kubernetes/client-node";
import type { McpServer } from "@/types";
import type { K8sPodState, K8sPodStatusSummary } from "./schemas";

/**
 * K8sPod manages a single MCP server running as a Kubernetes pod.
 * This is analogous to PodmanContainer in the desktop app.
 */
export default class K8sPod {
  private mcpServer: McpServer;
  private k8sApi: k8s.CoreV1Api;
  private k8sExec: k8s.Exec;
  private namespace: string;
  private podName: string;
  private state: K8sPodState = "not_created";
  private errorMessage: string | null = null;

  // Track assigned port for HTTP-based MCP servers
  assignedHttpPort?: number;

  constructor(
    mcpServer: McpServer,
    k8sApi: k8s.CoreV1Api,
    k8sExec: k8s.Exec,
    namespace: string,
  ) {
    this.mcpServer = mcpServer;
    this.k8sApi = k8sApi;
    this.k8sExec = k8sExec;
    this.namespace = namespace;
    this.podName = `mcp-${mcpServer.id.toLowerCase()}`;
  }

  /**
   * Get the base image for MCP server containers
   * This should match the image used in desktop_app
   */
  private getBaseImage(): string {
    // TODO: Update this to match your container registry
    return process.env.MCP_SERVER_BASE_IMAGE || "archestra/mcp-server:latest";
  }

  /**
   * Create environment variables for the pod
   */
  private createPodEnv(): k8s.V1EnvVar[] {
    const env: k8s.V1EnvVar[] = [];

    // TODO: Load OAuth tokens and user config from related catalog item and secrets
    // For now, just return basic environment

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
      } catch (error: unknown) {
        // Pod doesn't exist, we'll create it below
        if (error instanceof Error && error.message.includes("404")) {
          throw error;
        }
      }

      // Create new pod
      console.log(
        `Creating pod ${this.podName} for MCP server ${this.mcpServer.name}`,
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
              image: this.getBaseImage(),
              env: this.createPodEnv(),
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
    try {
      // For K8s, we need to use exec to interact with stdin/stdout
      // This is a simplified implementation - you may need to enhance this
      // based on your specific MCP server implementation

      const command = ["/bin/sh", "-c", "cat"];

      const exec = await this.k8sExec.exec(
        this.namespace,
        this.podName,
        "mcp-server",
        command,
        // biome-ignore lint/suspicious/noExplicitAny: TODO: fix this type..
        responseStream as any,
        null,
        process.stdin,
        true /* tty */,
      );

      // Write request to stdin
      if (exec.stdin) {
        exec.stdin.write(JSON.stringify(request));
        exec.stdin.end();
      }
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
