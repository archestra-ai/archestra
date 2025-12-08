import { PassThrough } from "node:stream";
import type { LocalConfigSchema } from "@shared";
import type Dockerode from "dockerode";
import type z from "zod";
import config from "@/config";
import logger from "@/logging";
import { InternalMcpCatalogModel } from "@/models";
import type { InternalMcpCatalog, McpServer } from "@/types";
import type { DockerPodState, DockerPodStatusSummary } from "./schemas";

const {
  orchestrator: { mcpServerBaseImage },
} = config;

/**
 * DockerPod manages a single MCP server running as a Docker container.
 * This is the Docker-native alternative to K8sPod for users running Archestra via Docker.
 */
export default class DockerPod {
  private mcpServer: McpServer;
  private docker: Dockerode;
  private containerName: string;
  private containerId?: string;
  private state: DockerPodState = "not_created";
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
    docker: Dockerode,
    catalogItem?: InternalMcpCatalog | null,
    userConfigValues?: Record<string, string>,
    environmentValues?: Record<string, string>,
  ) {
    this.mcpServer = mcpServer;
    this.docker = docker;
    this.catalogItem = catalogItem;
    this.userConfigValues = userConfigValues;
    this.environmentValues = environmentValues;
    this.containerName = DockerPod.constructContainerName(mcpServer);
  }

  /**
   * Constructs a valid Docker container name for an MCP server.
   * Container names must match [a-zA-Z0-9][a-zA-Z0-9_.-]+
   */
  static constructContainerName(mcpServer: McpServer): string {
    const slugified = DockerPod.ensureDockerNameCompliant(mcpServer.name);
    return `mcp-${slugified}`.substring(0, 128);
  }

  /**
   * Ensures a string is Docker container name compliant.
   * Docker container names must:
   * - Start with a letter or number
   * - Contain only letters, numbers, underscores, periods, or hyphens
   */
  static ensureDockerNameCompliant(input: string): string {
    return input
      .toLowerCase()
      .replace(/\s+/g, "-") // replace whitespace with hyphens
      .replace(/[^a-z0-9_.-]/g, "") // remove invalid characters
      .replace(/-+/g, "-") // collapse consecutive hyphens
      .replace(/^[^a-z0-9]+/, "") // remove leading non-alphanumeric
      .replace(/[^a-z0-9]+$/, ""); // remove trailing non-alphanumeric
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
   * Create environment variables for the container
   */
  createContainerEnv(): string[] {
    const env: string[] = [];
    const envMap = new Map<string, string>();

    // Process all environment variables from catalog
    if (this.catalogItem?.localConfig?.environment) {
      for (const envDef of this.catalogItem.localConfig.environment) {
        let value: string | undefined;
        if (envDef.promptOnInstallation) {
          value = this.environmentValues?.[envDef.key];
        } else {
          value = envDef.value;

          // Interpolate ${user_config.xxx} placeholders
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

        if (value) {
          envMap.set(envDef.key, value);
        }
      }
    } else if (this.environmentValues) {
      // Fallback: process environmentValues directly
      Object.entries(this.environmentValues).forEach(([key, value]) => {
        envMap.set(key, value);
      });
    }

    // Add user config values as environment variables
    if (this.userConfigValues) {
      Object.entries(this.userConfigValues).forEach(([key, value]) => {
        const envKey = key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
        envMap.set(envKey, value);
      });
    }

    // Convert map to Docker env format (KEY=VALUE)
    envMap.forEach((value, key) => {
      let processedValue = String(value);

      // Strip surrounding quotes
      if (
        processedValue.length > 1 &&
        ((processedValue.startsWith("'") && processedValue.endsWith("'")) ||
          (processedValue.startsWith('"') && processedValue.endsWith('"')))
      ) {
        processedValue = processedValue.slice(1, -1);
      }

      env.push(`${key}=${processedValue}`);
    });

    return env;
  }

  /**
   * Generate container creation options
   */
  generateContainerOptions(
    dockerImage: string,
    localConfig: z.infer<typeof LocalConfigSchema>,
    needsHttp: boolean,
    httpPort: number,
  ): Dockerode.ContainerCreateOptions {
    const cmd: string[] = [];

    if (localConfig.command) {
      cmd.push(localConfig.command);
    }

    if (localConfig.arguments) {
      const processedArgs = localConfig.arguments.map((arg) => {
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
      });
      cmd.push(...processedArgs);
    }

    const options: Dockerode.ContainerCreateOptions = {
      name: this.containerName,
      Image: dockerImage,
      Env: this.createContainerEnv(),
      Labels: {
        "archestra.mcp-server": "true",
        "archestra.mcp-server-id": this.mcpServer.id,
        "archestra.mcp-server-name": this.mcpServer.name,
      },
      // For stdio-based MCP servers, we need stdin open
      OpenStdin: true,
      StdinOnce: false,
      Tty: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        AutoRemove: false,
        RestartPolicy: {
          Name: "unless-stopped",
        },
      },
    };

    // Only set Cmd if we have a command
    if (cmd.length > 0) {
      options.Cmd = cmd;
    }

    // For HTTP-based servers, expose port
    if (needsHttp) {
      options.ExposedPorts = {
        [`${httpPort}/tcp`]: {},
      };
      options.HostConfig = {
        ...options.HostConfig,
        PortBindings: {
          [`${httpPort}/tcp`]: [{ HostPort: "0" }], // Dynamic port assignment
        },
      };
    }

    return options;
  }

  /**
   * Check if this MCP server needs an HTTP port
   */
  private async needsHttpPort(): Promise<boolean> {
    const catalogItem = await this.getCatalogItem();
    if (!catalogItem?.localConfig) {
      return false;
    }
    const transportType = catalogItem.localConfig.transportType || "stdio";
    return transportType === "streamable-http";
  }

  /**
   * Create or start the container for this MCP server
   */
  async startOrCreateContainer(): Promise<void> {
    try {
      // Check if container already exists
      try {
        const existingContainer = this.docker.getContainer(this.containerName);
        const inspectData = await existingContainer.inspect();
        this.containerId = inspectData.Id;

        if (inspectData.State.Running) {
          this.state = "running";
          await this.assignHttpPortIfNeeded(inspectData);
          logger.info(`Container ${this.containerName} is already running`);
          return;
        }

        // Container exists but not running - start it
        if (
          inspectData.State.Status === "exited" ||
          inspectData.State.Status === "created"
        ) {
          logger.info(`Starting existing container ${this.containerName}`);
          await existingContainer.start();
          this.state = "running";
          const updatedInspect = await existingContainer.inspect();
          await this.assignHttpPortIfNeeded(updatedInspect);
          return;
        }

        // Container in failed state - remove and recreate
        if (
          inspectData.State.Status === "dead" ||
          inspectData.State.ExitCode !== 0
        ) {
          logger.info(`Removing failed container ${this.containerName}`);
          await existingContainer.remove({ force: true });
        }
      } catch (error: unknown) {
        // Container doesn't exist (404), we'll create it below
        const isNotFound =
          error &&
          typeof error === "object" &&
          "statusCode" in error &&
          error.statusCode === 404;

        if (!isNotFound) {
          throw error;
        }
      }

      // Get catalog item for local config
      const catalogItem = await this.getCatalogItem();

      if (!catalogItem?.localConfig) {
        throw new Error(
          `Local config not found for MCP server ${this.mcpServer.name}`,
        );
      }

      // Create new container
      logger.info(
        `Creating container ${this.containerName} for MCP server ${this.mcpServer.name}`,
      );

      if (catalogItem.localConfig.command) {
        logger.info(
          `Using command: ${catalogItem.localConfig.command} ${(catalogItem.localConfig.arguments || []).join(" ")}`,
        );
      } else {
        logger.info("Using Docker image's default CMD");
      }

      this.state = "pending";

      // Use custom Docker image if provided
      const dockerImage =
        catalogItem.localConfig.dockerImage || mcpServerBaseImage;
      logger.info(`Using Docker image: ${dockerImage}`);

      // Pull image if needed
      await this.pullImageIfNeeded(dockerImage);

      // Check if HTTP port is needed
      const needsHttp = await this.needsHttpPort();
      const httpPort = catalogItem.localConfig.httpPort || 8080;

      // Create the container
      const normalizedLocalConfig = {
        ...catalogItem.localConfig,
        environment: catalogItem.localConfig.environment?.map((env) => ({
          ...env,
          required: env.required ?? false,
          description: env.description ?? "",
        })),
      };

      const container = await this.docker.createContainer(
        this.generateContainerOptions(
          dockerImage,
          normalizedLocalConfig,
          needsHttp,
          httpPort,
        ),
      );

      this.containerId = container.id;

      // Start the container
      await container.start();

      logger.info(`Container ${this.containerName} created and started`);

      // For HTTP servers, get the assigned port
      if (needsHttp) {
        const inspectData = await container.inspect();
        await this.assignHttpPortIfNeeded(inspectData);

        const httpPath = catalogItem.localConfig.httpPath || "/mcp";
        if (this.assignedHttpPort) {
          this.httpEndpointUrl = `http://localhost:${this.assignedHttpPort}${httpPath}`;
          logger.info(
            `HTTP endpoint URL for ${this.containerName}: ${this.httpEndpointUrl}`,
          );
        }
      }

      this.state = "running";
      logger.info(`Container ${this.containerName} is now running`);
    } catch (error: unknown) {
      this.state = "failed";
      this.errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { err: error },
        `Failed to start container ${this.containerName}:`,
      );
      throw error;
    }
  }

  /**
   * Pull Docker image if not present locally
   */
  private async pullImageIfNeeded(image: string): Promise<void> {
    try {
      // Check if image exists locally
      await this.docker.getImage(image).inspect();
      logger.debug(`Image ${image} already exists locally`);
    } catch (error: unknown) {
      const isNotFound =
        error &&
        typeof error === "object" &&
        "statusCode" in error &&
        error.statusCode === 404;

      if (isNotFound) {
        logger.info(`Pulling image ${image}...`);

        await new Promise<void>((resolve, reject) => {
          this.docker.pull(image, {}, (err, stream) => {
            if (err) {
              reject(err);
              return;
            }

            if (!stream) {
              reject(new Error("Failed to get pull stream"));
              return;
            }

            // Follow the pull progress
            this.docker.modem.followProgress(
              stream,
              (pullErr: Error | null) => {
                if (pullErr) {
                  reject(pullErr);
                } else {
                  logger.info(`Successfully pulled image ${image}`);
                  resolve();
                }
              },
              (event: { status?: string; progress?: string }) => {
                if (event.status) {
                  logger.debug(`Pull progress: ${event.status}`);
                }
              },
            );
          });
        });
      } else {
        throw error;
      }
    }
  }

  /**
   * Assign HTTP port from container port bindings
   */
  private async assignHttpPortIfNeeded(
    inspectData: Dockerode.ContainerInspectInfo,
  ): Promise<void> {
    const needsHttp = await this.needsHttpPort();
    if (!needsHttp) {
      return;
    }

    const catalogItem = await this.getCatalogItem();
    const httpPort = catalogItem?.localConfig?.httpPort || 8080;

    const portBindings = inspectData.NetworkSettings?.Ports;
    const binding = portBindings?.[`${httpPort}/tcp`]?.[0];

    if (binding?.HostPort) {
      this.assignedHttpPort = parseInt(binding.HostPort, 10);
      const httpPath = catalogItem?.localConfig?.httpPath || "/mcp";
      this.httpEndpointUrl = `http://localhost:${this.assignedHttpPort}${httpPath}`;
      logger.info(
        `Assigned HTTP port ${this.assignedHttpPort} for container ${this.containerName}`,
      );
    }
  }

  /**
   * Wait for container to be ready
   * Alias: waitForPodReady for compatibility with K8sPod interface
   */
  async waitForContainerReady(
    maxAttempts = 30,
    intervalMs = 2000,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const container = this.docker.getContainer(
          this.containerId || this.containerName,
        );
        const inspectData = await container.inspect();

        if (inspectData.State.Running) {
          return;
        }

        if (inspectData.State.Status === "exited") {
          this.state = "failed";
          this.errorMessage = `Container exited with code ${inspectData.State.ExitCode}`;
          throw new Error(
            `Container ${this.containerName} exited unexpectedly`,
          );
        }
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message.includes("exited unexpectedly")
        ) {
          throw error;
        }
        // Continue waiting for other errors
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `Container ${this.containerName} did not become ready after ${maxAttempts} attempts`,
    );
  }

  /**
   * Alias for waitForContainerReady - for compatibility with K8sPod interface
   */
  async waitForPodReady(maxAttempts = 30, intervalMs = 2000): Promise<void> {
    return this.waitForContainerReady(maxAttempts, intervalMs);
  }

  /**
   * Stop the container
   */
  async stopContainer(): Promise<void> {
    try {
      logger.info(`Stopping container ${this.containerName}`);
      const container = this.docker.getContainer(
        this.containerId || this.containerName,
      );

      try {
        await container.stop({ t: 10 }); // 10 second timeout
      } catch (error: unknown) {
        // Container might already be stopped
        const isNotRunning =
          error &&
          typeof error === "object" &&
          "statusCode" in error &&
          error.statusCode === 304;

        if (!isNotRunning) {
          throw error;
        }
      }

      this.state = "not_created";
      logger.info(`Container ${this.containerName} stopped`);
    } catch (error: unknown) {
      const isNotFound =
        error &&
        typeof error === "object" &&
        "statusCode" in error &&
        error.statusCode === 404;

      if (isNotFound) {
        logger.info(`Container ${this.containerName} already removed`);
        this.state = "not_created";
        return;
      }

      logger.error(
        { err: error },
        `Failed to stop container ${this.containerName}:`,
      );
      throw error;
    }
  }

  /**
   * Remove the container completely
   */
  async removeContainer(): Promise<void> {
    try {
      const container = this.docker.getContainer(
        this.containerId || this.containerName,
      );

      // Stop first if running
      try {
        const inspectData = await container.inspect();
        if (inspectData.State.Running) {
          await container.stop({ t: 10 });
        }
      } catch {
        // Ignore errors - container might not exist
      }

      // Remove the container
      await container.remove({ force: true });
      this.state = "not_created";
      this.containerId = undefined;
      logger.info(`Container ${this.containerName} removed`);
    } catch (error: unknown) {
      const isNotFound =
        error &&
        typeof error === "object" &&
        "statusCode" in error &&
        error.statusCode === 404;

      if (isNotFound) {
        logger.info(`Container ${this.containerName} already removed`);
        this.state = "not_created";
        return;
      }

      logger.error(
        { err: error },
        `Failed to remove container ${this.containerName}:`,
      );
      throw error;
    }
  }

  /**
   * Get recent logs from the container
   */
  async getRecentLogs(lines: number = 100): Promise<string> {
    try {
      const container = this.docker.getContainer(
        this.containerId || this.containerName,
      );

      const logs = await container.logs({
        stdout: true,
        stderr: true,
        tail: lines,
        timestamps: false,
      });

      // Docker logs come as Buffer with stream headers, clean them up
      return this.cleanDockerLogs(logs);
    } catch (error: unknown) {
      logger.error(
        { err: error },
        `Failed to get logs for container ${this.containerName}:`,
      );

      const isNotFound =
        error &&
        typeof error === "object" &&
        "statusCode" in error &&
        error.statusCode === 404;

      if (isNotFound) {
        return "Container not found";
      }
      throw error;
    }
  }

  /**
   * Clean Docker log output (remove stream headers)
   */
  private cleanDockerLogs(logs: Buffer | string): string {
    if (typeof logs === "string") {
      return logs;
    }

    // Docker multiplexed stream format: 8-byte header followed by payload
    // Header: [STREAM_TYPE, 0, 0, 0, SIZE1, SIZE2, SIZE3, SIZE4]
    const lines: string[] = [];
    let offset = 0;

    while (offset < logs.length) {
      if (offset + 8 > logs.length) {
        // Not enough bytes for header, treat rest as raw data
        lines.push(logs.slice(offset).toString("utf8"));
        break;
      }

      // Read payload size from header bytes 4-7 (big-endian)
      const size = logs.readUInt32BE(offset + 4);
      offset += 8;

      if (offset + size > logs.length) {
        // Incomplete payload, read what's available
        lines.push(logs.slice(offset).toString("utf8"));
        break;
      }

      const payload = logs.slice(offset, offset + size).toString("utf8");
      lines.push(payload);
      offset += size;
    }

    return lines.join("");
  }

  /**
   * Stream logs from the container with follow enabled
   */
  async streamLogs(
    responseStream: NodeJS.WritableStream,
    lines: number = 100,
  ): Promise<void> {
    try {
      const container = this.docker.getContainer(
        this.containerId || this.containerName,
      );

      const logStream = await container.logs({
        stdout: true,
        stderr: true,
        tail: lines,
        follow: true,
        timestamps: false,
      });

      // Create a PassThrough to handle the stream
      const passThrough = new PassThrough();

      // Pipe container logs through our processor
      if (logStream instanceof Buffer) {
        passThrough.write(this.cleanDockerLogs(logStream));
        passThrough.end();
      } else {
        logStream.on("data", (chunk: Buffer) => {
          const cleaned = this.cleanDockerLogs(chunk);
          passThrough.write(cleaned);
        });

        logStream.on("end", () => {
          passThrough.end();
        });

        logStream.on("error", (error: Error) => {
          passThrough.destroy(error);
        });
      }

      // Handle data flow
      passThrough.on("data", (chunk) => {
        if (!("destroyed" in responseStream) || !responseStream.destroyed) {
          responseStream.write(chunk);
        }
      });

      passThrough.on("end", () => {
        if (!("destroyed" in responseStream) || !responseStream.destroyed) {
          responseStream.end();
        }
      });

      passThrough.on("error", (error) => {
        logger.error(
          { err: error },
          `Log stream error for container ${this.containerName}:`,
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

      // Handle response stream cleanup
      responseStream.on("close", () => {
        passThrough.destroy();
      });
    } catch (error: unknown) {
      logger.error(
        { err: error },
        `Failed to stream logs for container ${this.containerName}:`,
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
   * Get the container's status summary
   */
  get statusSummary(): DockerPodStatusSummary {
    return {
      state: this.state,
      message:
        this.state === "running"
          ? "Container is running"
          : this.state === "pending"
            ? "Container is starting"
            : this.state === "failed"
              ? "Container failed"
              : "Container not created",
      error: this.errorMessage,
      containerName: this.containerName,
      containerId: this.containerId || null,
    };
  }

  get name(): string {
    return this.containerName;
  }

  get id(): string | undefined {
    return this.containerId;
  }

  /**
   * Get the Docker client instance
   */
  get dockerClient(): Dockerode {
    return this.docker;
  }

  /**
   * Check if this container uses streamable HTTP transport
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
