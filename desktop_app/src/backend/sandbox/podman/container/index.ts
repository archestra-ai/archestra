import type { RawReplyDefaultExpression } from 'fastify';
import fs from 'fs';
import path from 'node:path';
import os from 'os';
import { type FileSize, createStream } from 'rotating-file-stream';
import type { Duplex } from 'stream';
import { Agent, request, upgrade } from 'undici';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import {
  Mount,
  SpecGenerator,
  containerCreateLibpod,
  containerDeleteLibpod,
  containerInspectLibpod,
  containerStartLibpod,
  containerStopLibpod,
  containerWaitLibpod,
} from '@backend/clients/libpod/gen';
import config from '@backend/config';
import type { McpServer, McpServerConfig, McpServerUserConfigValues } from '@backend/models/mcpServer';
import log from '@backend/utils/logger';
import { parseBoolean } from '@backend/utils/parse';
import { LOGS_DIRECTORY } from '@backend/utils/paths';
import { FILE_SYSTEM_BASE_MOUNT_PATH } from '@constants';

export const PodmanContainerStateSchema = z.enum([
  'not_created',
  'created',
  'initializing',
  'running',
  'error',
  'restarting',
  'stopping',
  'stopped',
  'exited',
]);

export const PodmanContainerStatusSummarySchema = z.object({
  /**
   * startupPercentage is a number between 0 and 100 that represents the percentage of the startup process that has been completed.
   */
  startupPercentage: z.number().min(0).max(100),
  /**
   * state is the current state of the container.
   */
  state: PodmanContainerStateSchema,
  /**
   * message is a string that gives a human-readable description of the current state of the container.
   */
  message: z.string().nullable(),
  /**
   * error is a string that gives a human-readable description of any errors that may have occured
   * during the container startup process (if one has)
   */
  error: z.string().nullable(),
});

type PodmanContainerState = z.infer<typeof PodmanContainerStateSchema>;
type PodmanContainerStatusSummary = z.infer<typeof PodmanContainerStatusSummarySchema>;

export default class PodmanContainer {
  containerName: string;
  private serverConfig: McpServerConfig;
  private mcpServer: McpServer; // Store the full McpServer object for OAuth access

  private userConfigValues: McpServerUserConfigValues | null;
  private command: string;
  private args: string[];
  private envVars: Record<string, string>;

  private startupPercentage = 0;
  private state: PodmanContainerState;
  private statusMessage: string | null = null;
  private statusError: string | null = null;

  private socketPath: string | null = null;

  // Assigned HTTP port for streamable HTTP servers (when random port is assigned by Podman)
  assignedHttpPort?: number;

  // Connection pooling for MCP server communication
  private mcpSocket: Duplex | null = null;
  private mcpSocketConnecting: boolean = false;
  private pendingRequests: Map<string, (response: any) => void> = new Map();

  /**
   * JSON accumulator to handle MCP messages that may be split across multiple data chunks.
   * The MCP protocol uses newline-delimited JSON, but when reading from a socket stream,
   * a single JSON message might be split across multiple 'data' events, or multiple
   * JSON messages might arrive in a single chunk. This accumulator ensures we only
   * try to parse complete JSON lines, preventing "Failed to parse MCP message" errors
   * for large responses (like tool results with extensive text content).
   */
  private jsonAccumulator: string = '';

  private logStream: NodeJS.WritableStream | null = null;

  private customImage: string | null = null;

  constructor(mcpServer: McpServer, socketPath: string) {
    const { name, serverConfig, userConfigValues } = mcpServer;
    this.containerName = PodmanContainer.prettifyServerNameIntoContainerName(name);
    this.serverConfig = serverConfig;
    this.mcpServer = mcpServer; // Store full object for OAuth access
    this.userConfigValues = userConfigValues;
    const { command, args, env } = PodmanContainer.injectUserConfigValuesIntoServerConfig(
      serverConfig,
      userConfigValues
    );

    // Check if this is a Docker-style configuration
    if (command === 'docker') {
      // Parse Docker run command to extract image and real args
      const dockerConfig = PodmanContainer.parseDockerCommand(args || []);
      this.customImage = dockerConfig.image;
      this.command = dockerConfig.command;
      this.args = dockerConfig.args;
      // Merge environment variables - OAuth tokens from env override Docker config placeholders
      this.envVars = { ...dockerConfig.env, ...env };
    } else {
      this.command = command;
      this.args = args || [];
      this.envVars = env;
    }

    // Set the socket path for the container (needed for attach operations)
    this.socketPath = socketPath;

    // Initialize state
    this.state = 'not_created';
    this.startupPercentage = 0;
    this.statusMessage = 'Container not yet created';
    this.statusError = null;
  }

  /**
   * NOTE: they're certain naming restrictions/conventions that we should follow here
   *
   * See:
   * https://kubernetes.io/docs/concepts/overview/working-with-objects/names/#dns-subdomain-names
   */
  private static prettifyServerNameIntoContainerName = (serverName: string) =>
    `archestra-ai-${serverName.replace(/ /g, '-').toLowerCase()}-mcp-server`;

  /**
   * Discover the assigned host port for streamable HTTP servers
   * This queries the container inspection API to get the actual port assigned by Podman
   */
  private async discoverAssignedHttpPort(): Promise<void> {
    try {
      log.info(`Discovering assigned HTTP port for container: ${this.containerName}`);

      const inspectResponse = await containerInspectLibpod({
        path: { name: this.containerName },
      });

      if (inspectResponse.response.status !== 200) {
        throw new Error(`Failed to inspect container: ${inspectResponse.response.status}`);
      }

      const portBindings = inspectResponse.data?.NetworkSettings?.Ports;
      log.info(`Available port bindings:`, Object.keys(portBindings || {}));

      if (portBindings) {
        // Look for any TCP port mapping (for existing containers)
        const tcpPorts = Object.keys(portBindings).filter((key) => key.endsWith('/tcp'));

        if (tcpPorts.length > 0) {
          // Use the first available TCP port mapping
          const portKey = tcpPorts[0];
          const hostPort = portBindings[portKey]?.[0]?.HostPort;

          if (hostPort) {
            this.assignedHttpPort = parseInt(hostPort, 10);
            const containerPort = portKey.replace('/tcp', '');
            log.info(`Assigned HTTP port discovered: ${this.assignedHttpPort} (container port: ${containerPort})`);
          } else {
            log.warn(`Port binding found (${portKey}) but no HostPort assigned`);
          }
        } else {
          log.warn(`No TCP port bindings found in container inspection`);
        }
      } else {
        log.warn(`No port bindings found in container inspection`);
      }
    } catch (error) {
      log.error('Failed to discover assigned HTTP port:', error);
    }
  }

  /**
   * Parse Docker/Podman run command arguments to extract image and configuration
   * Handles commands like: ["run", "--rm", "-i", "-e", "LINKEDIN_COOKIE", "stickerdaniel/linkedin-mcp-server:latest"]
   */
  private static parseDockerCommand(args: string[]): {
    image: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  } {
    let image = '';
    const env: Record<string, string> = {};
    const dockerArgs: string[] = [];
    let i = 0;

    // Skip 'run' if it's the first argument
    if (args[0] === 'run') {
      i = 1;
    }

    // Parse flags and options
    while (i < args.length) {
      const arg = args[i];

      if (arg === '-e' || arg === '--env') {
        // Environment variable
        i++;
        if (i < args.length) {
          const envVar = args[i];
          // Check if it's KEY=VALUE format or just KEY
          if (envVar.includes('=')) {
            const [key, ...valueParts] = envVar.split('=');
            env[key] = valueParts.join('=');
          } else {
            // Just the key, value will come from env vars
            env[envVar] = '';
          }
        }
        i++;
      } else if (arg.startsWith('-')) {
        // Other Docker flags we want to skip (--rm, -i, etc.)
        if (
          arg === '--rm' ||
          arg === '-i' ||
          arg === '--interactive' ||
          arg === '-t' ||
          arg === '--tty' ||
          arg === '-it'
        ) {
          i++;
        } else {
          // Unknown flag, skip it and its value if needed
          i++;
          // Some flags take values, skip the next arg if it doesn't start with -
          if (i < args.length && !args[i].startsWith('-')) {
            i++;
          }
        }
      } else {
        // This should be the image name
        image = arg;
        i++;
        // Everything after the image is the command and its args
        while (i < args.length) {
          dockerArgs.push(args[i]);
          i++;
        }
        break;
      }
    }

    // If no command specified after the image, don't set command/args
    // This allows the container to use its default entrypoint
    const command = dockerArgs.length > 0 ? dockerArgs[0] : '';
    const commandArgs = dockerArgs.slice(1);

    return {
      image,
      command,
      args: commandArgs,
      env,
    };
  }

  private async startLoggingToFile() {
    try {
      // Create rotating file stream for log file
      const { mcpServerLogMaxSize, mcpServerLogMaxFiles } = config.logging;

      this.logStream = createStream(
        (_time, index) => {
          // Custom filename generator to create numeric suffixes;
          return `${this.containerName}-${(index || 0) + 1}.log`;
        },
        {
          path: LOGS_DIRECTORY,
          /**
           * Rotate files when they reach this size, e.g. '5M'
           */
          size: mcpServerLogMaxSize as FileSize,
          /**
           * Keep only N rotated files
           */
          maxFiles: mcpServerLogMaxFiles,
          /**
           * Don't compress rotated files
           */
          compress: false,
          /**
           * See https://github.com/iccicci/rotating-file-stream?tab=readme-ov-file#history
           * (and comment above `getLogHistoryFileName` for more info)
           */
          history: this.getLogHistoryFileName(),
        }
      );

      this.logStream.write(`\n=== Container started at ${new Date().toISOString()} ===\n`);
      log.info(
        `Started logging to: ${LOGS_DIRECTORY} (rotation: ${mcpServerLogMaxSize}, max files: ${mcpServerLogMaxFiles})`
      );
    } catch (error) {
      log.error(`Failed to create log file stream:`, error);
    }
  }

  /**
   * Stop streaming container logs
   */
  private stopStreamingLogs() {
    if (this.logStream) {
      this.logStream.write(`\n=== Container stopped at ${new Date().toISOString()} ===\n`);
      this.logStream.end();
      this.logStream = null;
      log.info(`Stopped streaming logs`);
    }
  }

  /**
   * Start streaming container logs
   */
  async startStreamingLogs() {
    if (this.logStream !== null) {
      log.info(`Already streaming logs for ${this.containerName}`);
      return;
    }

    log.info(`Starting to stream logs for ${this.containerName}`);

    try {
      // Start logging to file
      await this.startLoggingToFile();

      /**
       * Use undici.request() for streaming logs
       *
       * TODO: don't hardcode the path here
       */
      const { body } = await request(
        `http://localhost/v5.0.0/libpod/containers/${this.containerName}/logs?follow=true&stdout=true&stderr=true&timestamps=true&tail=all`,
        {
          method: 'GET',
          // Create an agent for the unix socket
          dispatcher: new Agent({
            connect: { socketPath: this.socketPath },
          }),
        }
      );

      if (!body) {
        throw new Error('No response body for logs');
      }

      // Process the streaming logs
      let buffer = Buffer.alloc(0);

      body.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);

        // Process multiplexed stream format (same as attach)
        while (buffer.length >= 8) {
          // Read the 8-byte header
          const streamType = buffer[0]; // 0=stdin, 1=stdout, 2=stderr
          const payloadSize = buffer.readUInt32BE(4);

          // Check if we have the full payload
          if (buffer.length < 8 + payloadSize) {
            break; // Wait for more data
          }

          // Extract the payload
          const payload = buffer.slice(8, 8 + payloadSize);
          buffer = buffer.slice(8 + payloadSize);

          // Convert payload to string
          const text = payload.toString('utf-8');

          // Write to log file
          if (this.logStream && text.trim()) {
            this.logStream.write(text);
            if (!text.endsWith('\n')) {
              this.logStream.write('\n');
            }
          }

          /**
           * Also log to console for debugging
           *
           * NOTE: let's not double output to console for right now.. this can get very verbose + spam
           * logs when developing (+ also, we're already logging to the file, which can be viewed in the UI as well)
           */
          // if (streamType === 1) {
          //   log.debug(`[${this.containerName} stdout]: ${text.trim()}`);
          // } else if (streamType === 2) {
          //   log.debug(`[${this.containerName} stderr]: ${text.trim()}`);
          // }
        }
      });

      body.on('error', (err: Error) => {
        log.error(`Error streaming logs for ${this.containerName}:`, err);
        this.stopStreamingLogs();
      });

      body.on('end', () => {
        log.info(`Log streaming ended for ${this.containerName}`);
        this.stopStreamingLogs();
      });

      log.info(`Container logs streaming started for ${this.containerName}`);
    } catch (error) {
      log.error(`Failed to start streaming logs:`, error);
      this.stopStreamingLogs();
    }
  }

  private setContainerAsRunning() {
    this.state = 'running';
    this.startupPercentage = 100;
    this.statusMessage = 'Container is running';
    this.statusError = null;
  }

  private setContainerAsError(error: string) {
    this.state = 'error';
    this.startupPercentage = 0;
    this.statusMessage = null;
    this.statusError = error;
  }

  /**
   * See https://github.com/iccicci/rotating-file-stream?tab=readme-ov-file#history
   * for more information on this history file and why rotating-file-stream creates it
   *
   * We give it an explicit name so that it doesn't get mixed up with other files in the log directory
   */
  private getLogHistoryFileName(): string {
    return `${this.containerName}-log-history.txt`;
  }

  private getContainerLogFilesInSortedOrder(): string[] {
    /**
     * Check if log directory exists
     */
    if (!fs.existsSync(LOGS_DIRECTORY)) {
      return [];
    }

    /**
     * Read all files in the log directory
     */
    const files = fs.readdirSync(LOGS_DIRECTORY);

    /**
     * Filter files to only include those for this container
     */
    const containerLogFiles = files.filter((file) => file.includes(this.containerName) && file.endsWith('.log'));

    /**
     * Sort files such that they'd be read in the correct order (desc order)
     *
     * Files are named as such (see `startLoggingToFile` function):
     * `${this.containerName}-${index + 1}.log`
     */
    return containerLogFiles.sort((a, b) => {
      const aNum = parseInt(a.substring(this.containerName.length + 1));
      const bNum = parseInt(b.substring(this.containerName.length + 1));
      return bNum - aNum;
    });
  }

  /**
   * Get recent logs from the log file
   */
  async getRecentLogs(lines: number = 100): Promise<string> {
    try {
      const sortedContainerLogFiles = this.getContainerLogFilesInSortedOrder();

      if (sortedContainerLogFiles.length === 0) {
        return `No logs available yet for ${this.containerName}`;
      }

      // Collect lines from all files until we have enough
      let allLines: string[] = [];

      log.info(
        `Getting recent logs for container ${this.containerName}.. found ${sortedContainerLogFiles.length} files`
      );

      for (const file of sortedContainerLogFiles) {
        const filePath = path.join(LOGS_DIRECTORY, file);

        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const fileLines = content.split('\n').filter((line) => line.trim() !== '');

          // Add lines to the beginning since we're reading from newest to oldest
          allLines = fileLines.concat(allLines);

          // If we have enough lines, we can stop reading older files
          if (allLines.length >= lines) {
            break;
          }
        } catch (error) {
          log.error(`Failed to read log file ${filePath}:`, error);
          // Continue with other files if one fails
        }
      }

      // Return the last N lines
      return allLines.slice(-lines).join('\n');
    } catch (error) {
      log.error(`Failed to read logs:`, error);
      return `Error reading logs: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  /**
   * Replaces template variables in server config with actual user config values.
   * Template variables follow the format: ${user_config.key}
   *
   * @param serverConfig - The server configuration containing potential template variables
   * @param userConfigValues - The user-provided values to substitute
   * @returns The server config with all template variables replaced
   */
  private static injectUserConfigValuesIntoServerConfig = (
    serverConfig: McpServerConfig,
    userConfigValues: McpServerUserConfigValues | null
  ) => {
    const hostToContainerPath = (hostPath: string): string => {
      const baseName = path.basename(hostPath);
      const sanitizedBaseName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
      return path.posix.join(FILE_SYSTEM_BASE_MOUNT_PATH, sanitizedBaseName);
    };
    const replaceTemplateVariables = (str: string): string => {
      if (!userConfigValues) return str;

      // Replace all occurrences of ${user_config.key} with the actual value
      return str.replace(/\$\{user_config\.([^}]+)\}/g, (match, key) => {
        const value = userConfigValues[key];
        if (value === undefined) {
          log.warn(`Template variable ${match} not found in user config values`);
          return match; // Return the original template if no value found
        }
        // Special handling for allowed_directories - map host paths to container paths
        if (key === 'allowed_directories' && Array.isArray(value)) {
          const containerPaths = value
            .filter((p) => typeof p === 'string' && p.trim() !== '')
            .map((p) => hostToContainerPath(p));
          return containerPaths.join(',');
        }

        // Convert the value to string (handles string, number, boolean)
        // For arrays, join them with commas
        if (Array.isArray(value)) {
          return value.join(',');
        }
        return String(value);
      });
    };

    // Process command
    const processedCommand = serverConfig.command ? replaceTemplateVariables(serverConfig.command) : '';

    // Process args if they exist; expand ${user_config.allowed_directories} into multiple args
    const processedArgs = serverConfig.args
      ? (() => {
          const out: string[] = [];
          for (const arg of serverConfig.args!) {
            if (arg === '${user_config.allowed_directories}') {
              if (userConfigValues && Array.isArray(userConfigValues.allowed_directories)) {
                const containerPaths = userConfigValues.allowed_directories
                  .filter((p) => typeof p === 'string' && p.trim() !== '')
                  .map((p) => hostToContainerPath(p));
                out.push(...containerPaths);
                continue;
              }
            }
            out.push(replaceTemplateVariables(arg));
          }
          return out;
        })()
      : undefined;

    // Process environment variables if they exist
    const processedEnv: Record<string, string> = {};
    if (serverConfig.env) {
      for (const [key, value] of Object.entries(serverConfig.env)) {
        processedEnv[key] = replaceTemplateVariables(value);
      }
    }

    return {
      command: processedCommand,
      args: processedArgs,
      env: processedEnv || {},
    };
  };

  /**
   * https://docs.podman.io/en/latest/_static/api.html#tag/containers/operation/ContainerStartLibpod
   */
  private async startContainer() {
    try {
      return await containerStartLibpod({
        path: {
          name: this.containerName,
        },
      });
    } catch (error) {
      log.error(`Error starting MCP server container ${this.containerName}`, error);
      throw error;
    }
  }

  /**
   * https://docs.podman.io/en/latest/_static/api.html#tag/containers/operation/ContainerCreateLibpod
   */
  async startOrCreateContainer() {
    log.info(
      `Starting MCP server container ${this.containerName} with image: ${this.customImage || config.sandbox.baseDockerImage}`
    );

    // Update state to initializing
    this.state = 'initializing';
    this.startupPercentage = 10;
    this.statusMessage = 'Starting MCP server container';
    this.statusError = null;

    try {
      const { response } = await this.startContainer();

      if (response.status === 304) {
        log.info(`MCP server container ${this.containerName} is already running.`);

        // For existing containers, we still need to discover the assigned port
        const oauthConfig = this.mcpServer.oauthConfig ? JSON.parse(this.mcpServer.oauthConfig as any) : null;
        const isStreamableHttp = oauthConfig?.streamable_http_url;

        if (isStreamableHttp) {
          log.info(`Discovering port for existing streamable HTTP container`);
          await this.discoverAssignedHttpPort();
        }

        // Update state
        this.setContainerAsRunning();

        // Start streaming logs even if container was already running
        await this.startStreamingLogs();
        return;
      } else if (response.status === 204) {
        log.info(`MCP server container ${this.containerName} started.`);

        // Update state
        this.state = 'initializing';
        this.startupPercentage = 50;
        this.statusMessage = 'Container started, waiting for health check';

        // Wait for container to be healthy before considering it ready
        await this.waitForHealthy();

        // Start streaming logs for newly started container
        await this.startStreamingLogs();

        this.setContainerAsRunning();
        return;
      }
    } catch (error) {
      // If container doesn't exist (404), we'll create it below
      if (error && typeof error === 'object' && 'response' in error && (error as any).response?.status === 404) {
        log.info(`Container ${this.containerName} doesn't exist, will create it...`);
        this.startupPercentage = 20;
        this.statusMessage = 'Container does not exist, creating new container';
      } else {
        log.error(`Error starting MCP server container ${this.containerName}`, error);
        this.setContainerAsError(error instanceof Error ? error.message : 'Failed to start container');
        throw error;
      }
    }

    log.info(`Container ${this.containerName} does not exist, creating it...`);

    try {
      // Update state for creation
      this.state = 'created';
      this.startupPercentage = 30;
      this.statusMessage = 'Creating container';

      // Only include command if it's not empty
      const createBody: SpecGenerator = {
        name: this.containerName,
        image: this.customImage || config.sandbox.baseDockerImage,
        env: this.envVars,
        /**
         * Keep stdin open for interactive communication with MCP servers
         */
        stdin: true,
        /**
         * Don't auto-remove the container - we need it to persist for MCP communication
         */
        remove: false,
      };

      // Only add command if we have one (let container use its default CMD/ENTRYPOINT if not)
      if (this.command) {
        createBody.command = [this.command, ...this.args];
      }

      // Configures volume mounts with necessary directories and files
      try {
        await this.configureVolumeMounts(createBody, this.userConfigValues);
      } catch (e) {
        log.warn('Failed to configure volume mounts into container create body', e);
        throw e;
      }

      // Check if this is a streamable HTTP server and add port bindings
      const oauthConfig = this.mcpServer.oauthConfig ? JSON.parse(this.mcpServer.oauthConfig as any) : null;
      const isStreamableHttp = oauthConfig?.streamable_http_url;

      if (isStreamableHttp) {
        const containerPort = oauthConfig?.streamable_http_port || 8000; // Default to 8000 if not specified

        log.info(`Detected streamable HTTP server, exposing container port ${containerPort} with random host port`);
        createBody.portmappings = [
          {
            container_port: containerPort,
            host_port: 0, // 0 = random available port
            protocol: 'tcp',
          },
        ];
      }

      const response = await containerCreateLibpod({
        body: createBody,
      });

      if (response.response.status !== 201) {
        log.error(`Container creation failed with status ${response.response.status}`);
        log.error(`Full createBody sent to API:`, JSON.stringify(createBody, null, 2));
        log.error(`Full API response:`, JSON.stringify(response, null, 2));
        throw new Error(`Failed to create container: ${response.response.status}`);
      }

      if (!response.data?.Id) {
        throw new Error('Container created but no ID returned');
      }

      log.info(`MCP server container ${this.containerName} created with ID: ${response.data.Id}`);

      // Update state
      this.startupPercentage = 40;
      this.statusMessage = 'Container created, starting it';

      await this.startContainer();

      // If this is a streamable HTTP server, discover the assigned host port after starting
      if (isStreamableHttp) {
        await this.discoverAssignedHttpPort();
      }

      // Wait for container to be healthy
      log.info(`MCP server container ${this.containerName} started, waiting for it to be healthy...`);
      this.startupPercentage = 60;
      this.statusMessage = 'Container started, waiting for health check';

      await this.waitForHealthy();

      // Start streaming logs
      this.startupPercentage = 90;
      this.statusMessage = 'Container healthy, starting log streaming';

      await this.startStreamingLogs();

      this.setContainerAsRunning();
    } catch (error: any) {
      // Log the full error details for debugging
      if (error.error) {
        log.error(`[PodmanContainer] Container creation failed:`, error.error);
      } else {
        log.error(`Error creating MCP server container ${this.containerName}:`, error);
      }

      // Extract meaningful error message
      const errorMessage = error?.error?.message || error?.message || 'Failed to create container';
      this.setContainerAsError(errorMessage);
      throw new Error(errorMessage);
    }
  }

  /**
   * Wait for container to be healthy using Podman's native wait API
   */
  async waitForHealthy(): Promise<boolean> {
    log.info(`Waiting for container ${this.containerName} to be healthy...`);

    try {
      const response = await containerWaitLibpod({
        path: {
          name: this.containerName,
        },
        query: {
          condition: ['healthy'],
          interval: '500ms',
        },
      });

      if (response.response.status === 200) {
        log.info(`Container ${this.containerName} is healthy!`);
        this.startupPercentage = 80;
        this.statusMessage = 'Container is healthy';
        return true;
      }

      this.statusMessage = 'Container health check failed';
      return false;
    } catch (error) {
      log.error(`Error waiting for container ${this.containerName} to be healthy:`, error);
      this.statusError = error instanceof Error ? error.message : 'Health check failed';
      return false;
    }
  }

  /**
   * https://docs.podman.io/en/latest/_static/api.html#tag/containers/operation/ContainerStopLibpod
   */
  async stopContainer() {
    log.info(`Stopping MCP server container ${this.containerName}`);

    // Update state
    this.state = 'stopping';
    this.statusMessage = 'Stopping container';
    this.statusError = null;

    // Close MCP socket connection if exists
    if (this.mcpSocket) {
      log.info('Closing MCP socket connection');
      this.mcpSocket.destroy();
      this.mcpSocket = null;
    }

    // Stop streaming logs before stopping container
    this.stopStreamingLogs();

    try {
      const { response } = await containerStopLibpod({
        path: {
          name: this.containerName,
        },
      });
      const { status } = response;

      if (status === 204) {
        log.info(`MCP server container ${this.containerName} stopped`);
        this.state = 'stopped';
        this.statusMessage = 'Container stopped successfully';
      } else if (status === 304) {
        log.info(`MCP server container ${this.containerName} already stopped`);
        this.state = 'stopped';
        this.statusMessage = 'Container was already stopped';
      } else if (status === 404) {
        log.info(`MCP server container ${this.containerName} not found, already stopped`);
        this.state = 'not_created';
        this.statusMessage = 'Container not found';
      } else {
        log.error(`Error stopping MCP server container ${this.containerName}`, response);
        this.setContainerAsError(`Unexpected status: ${status}`);
      }

      this.startupPercentage = 0;
    } catch (error) {
      log.error(`Error stopping MCP server container ${this.containerName}`, error);
      this.setContainerAsError(error instanceof Error ? error.message : 'Failed to stop container');
      throw error;
    }
  }

  /**
   * Get or create a persistent socket connection to the MCP server container
   */
  private async getOrCreateMcpSocket(): Promise<Duplex> {
    // If we already have a socket, return it
    if (this.mcpSocket && !this.mcpSocket.destroyed) {
      return this.mcpSocket;
    }

    // If we're already connecting, wait for it
    if (this.mcpSocketConnecting) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return this.getOrCreateMcpSocket();
    }

    this.mcpSocketConnecting = true;
    this.jsonAccumulator = ''; // Reset accumulator for new connection

    try {
      log.info(`Creating new MCP socket connection to ${this.containerName}`);

      // First check if container is healthy
      const containerIsHealthy = await this.waitForHealthy();
      if (!containerIsHealthy) {
        throw new Error(`Container ${this.containerName} is not healthy`);
      }

      // Create an agent for the unix socket
      const agent = new Agent({
        connect: { socketPath: this.socketPath },
      });

      // Use undici.upgrade() for WebSocket-style upgrades
      const { socket } = await upgrade(
        `http://localhost/v5.0.0/libpod/containers/${this.containerName}/attach?stream=true&stdin=true&stdout=true&stderr=true`,
        {
          method: 'POST',
          dispatcher: agent,
          protocol: 'tcp',
        }
      );

      if (!socket) {
        throw new Error('Failed to create socket');
      }

      log.info('MCP socket connection established');
      this.mcpSocket = socket;
      this.mcpSocketConnecting = false;

      // Set up socket data handler
      let responseBuffer = Buffer.alloc(0);

      socket.on('data', (chunk: Buffer) => {
        responseBuffer = Buffer.concat([responseBuffer, chunk]);

        // Process multiplexed stream format
        while (responseBuffer.length >= 8) {
          // Read the 8-byte header
          const streamType = responseBuffer[0]; // 0=stdin, 1=stdout, 2=stderr
          const payloadSize = responseBuffer.readUInt32BE(4);

          // Check if we have the full payload
          if (responseBuffer.length < 8 + payloadSize) {
            break; // Wait for more data
          }

          // Extract the payload
          const payload = responseBuffer.slice(8, 8 + payloadSize);
          responseBuffer = responseBuffer.slice(8 + payloadSize);

          // Process stdout (stream type 1)
          if (streamType === 1) {
            const text = payload.toString('utf-8');
            if (text) {
              // Append new data to the accumulator. This handles cases where:
              // 1. A JSON message is split across multiple socket data events
              // 2. Multiple complete JSON messages arrive in a single chunk
              // 3. Large tool responses (e.g., library documentation) exceed buffer sizes
              this.jsonAccumulator += text;

              // Split by newlines to identify complete messages (MCP uses newline-delimited JSON)
              const lines = this.jsonAccumulator.split('\n');

              // The last element might be an incomplete JSON message, so keep it for next chunk
              this.jsonAccumulator = lines.pop() || '';

              // Process only complete lines (ones that ended with \n)
              for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine && trimmedLine.startsWith('{')) {
                  try {
                    const parsed = JSON.parse(trimmedLine);
                    log.debug(`Received MCP message:`, { id: parsed.id, method: parsed.method });

                    // Handle responses with IDs
                    if (parsed.id !== undefined && this.pendingRequests.has(parsed.id.toString())) {
                      const callback = this.pendingRequests.get(parsed.id.toString());
                      this.pendingRequests.delete(parsed.id.toString());
                      callback?.(parsed);
                    } else if (parsed.method) {
                      // This is a notification - we might need to handle these differently
                      log.debug(`MCP notification: ${parsed.method}`);
                    }
                  } catch (e) {
                    log.error(`Failed to parse MCP message: ${trimmedLine.substring(0, 500)}`);
                    log.error(`Parse error:`, e);
                  }
                }
              }
            }
          } else if (streamType === 2) {
            // stderr
            const text = payload.toString('utf-8').trim();
            if (text) {
              log.debug(`Container stderr: ${text}`);
            }
          }
        }
      });

      socket.on('error', (err: Error) => {
        log.error('MCP socket error:', err);
        this.mcpSocket = null;
        this.jsonAccumulator = ''; // Clear accumulator on error
        // Reject all pending requests
        for (const [id, callback] of this.pendingRequests) {
          callback({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32603,
              message: `Socket error: ${err.message}`,
            },
          });
        }
        this.pendingRequests.clear();
      });

      socket.on('close', () => {
        log.info('MCP socket closed');
        this.mcpSocket = null;
        this.jsonAccumulator = ''; // Clear accumulator on close
        // Reject all pending requests
        for (const [id, callback] of this.pendingRequests) {
          callback({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32603,
              message: 'Connection closed',
            },
          });
        }
        this.pendingRequests.clear();
      });

      return socket;
    } catch (error) {
      this.mcpSocketConnecting = false;
      throw error;
    }
  }

  /**
   * Stream bidirectional communication with the MCP server container!
   *
   * MCP servers communicate via stdin/stdout using JSON-RPC protocol.
   *
   * We use raw HTTP requests here instead of the libpod SDK because the container attach
   * endpoint hijacks the HTTP connection to create a bidirectional TCP stream. The SDK
   * doesn't support this hijacking mechanism - after the 101 Upgrade response, the connection
   * becomes a raw TCP socket for stdin/stdout/stderr multiplexing, which requires manual
   * handling of the stream protocol.
   *
   * https://docs.podman.io/en/latest/_static/api.html#tag/containers/operation/ContainerAttachLibpod
   */
  async streamToContainer(requestBody: any, responseStream: RawReplyDefaultExpression) {
    // Log the original request
    log.info(`MCP request:`, {
      method: requestBody.method,
      id: requestBody.id,
      idType: typeof requestBody.id,
    });

    const originalId = requestBody.id;

    try {
      // Get or create the socket connection
      const socket = await this.getOrCreateMcpSocket();

      // For notifications (no ID), just send and return immediately
      if (requestBody.id === undefined && requestBody.method?.includes('notification')) {
        const jsonRequest = JSON.stringify(requestBody) + '\n';
        socket.write(jsonRequest);
        log.info(`Sent notification: ${requestBody.method}`);

        // Return empty success response for notifications
        responseStream.write('{}');
        responseStream.end();
        return;
      }

      // For requests with IDs, we need to track the response
      const requestId = originalId !== undefined ? originalId.toString() : uuidv4();

      // Prepare the JSON-RPC request with newline (MCP servers expect line-delimited JSON)
      const jsonRequest = JSON.stringify(requestBody) + '\n';
      log.info(`Sending JSON-RPC request: ${jsonRequest}`);

      // Set up response handler
      const responsePromise = new Promise<any>((resolve) => {
        this.pendingRequests.set(requestId, resolve);
      });

      // Send the request
      socket.write(jsonRequest);

      // Wait for response with timeout
      const timeoutPromise = new Promise<any>((resolve) => {
        setTimeout(() => {
          resolve({
            jsonrpc: '2.0',
            id: originalId,
            error: {
              code: -32603,
              message: 'Timeout waiting for MCP server response',
            },
          });
        }, 30000); // 30 second timeout
      });

      const response = await Promise.race([responsePromise, timeoutPromise]);

      // Clean up pending request if it's still there
      this.pendingRequests.delete(requestId);

      // Send response back to client (response is already a parsed object)
      const responseJson = JSON.stringify(response);
      log.info(`Sending response back to client: ${responseJson.substring(0, 100)}...`);
      responseStream.write(responseJson);
      responseStream.end();
    } catch (error) {
      log.error(`Error in streamToContainer:`, error);
      responseStream.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: originalId,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        })
      );
      responseStream.end();
    }
  }

  get statusSummary(): PodmanContainerStatusSummary {
    return {
      startupPercentage: this.startupPercentage,
      state: this.state,
      message: this.statusMessage,
      error: this.statusError,
    };
  }

  /**
   * Remove the container from Podman
   */
  async removeContainer() {
    try {
      log.info(`Removing container: ${this.containerName}`);

      // Stop the container first if it's running
      if (this.state === 'running') {
        await this.stopContainer();
      }

      // Remove the container using libpod API
      await containerDeleteLibpod({
        path: {
          name: this.containerName,
        },
        query: {
          force: true, // Force removal even if running
          v: true, // Remove volumes associated with the container
        },
      });

      // Clean up log files related to this container
      await this.cleanupLogFiles();

      this.state = 'not_created';
      log.info(`Container ${this.containerName} removed successfully`);
    } catch (error) {
      log.error(`Failed to remove container ${this.containerName}:`, error);
      throw error;
    }
  }

  /**
   * Clean up log files for this container
   */
  async cleanupLogFiles() {
    try {
      log.info(`Cleaning up log files for container: ${this.containerName}`);

      // Stop logging if still active
      this.stopStreamingLogs();

      const containerLogFiles = this.getContainerLogFilesInSortedOrder();

      // Delete each log file
      for (const file of containerLogFiles) {
        const filePath = path.join(LOGS_DIRECTORY, file);
        try {
          await fs.promises.unlink(filePath);
          log.info(`Deleted log file: ${filePath}`);
        } catch (error) {
          log.error(`Failed to delete log file ${filePath}:`, error);
        }
      }

      // Cleanup the "log history" file
      const logHistoryFileName = this.getLogHistoryFileName();
      const logHistoryFilePath = path.join(LOGS_DIRECTORY, logHistoryFileName);
      try {
        await fs.promises.unlink(logHistoryFilePath);
        log.info(`Deleted log history file: ${logHistoryFilePath}`);
      } catch (error) {
        log.error(`Failed to delete log history file ${logHistoryFilePath}:`, error);
      }

      log.info(`Cleaned up ${containerLogFiles.length} log file(s) for container ${this.containerName}`);
    } catch (error) {
      log.error(`Failed to cleanup log files for ${this.containerName}:`, error);
      // Don't throw here - log cleanup failure shouldn't prevent container removal
    }
  }

  private buildMount(hostPath: string, destination: string, readOnly: boolean): Mount {
    return {
      Type: 'bind',
      Source: hostPath,
      Destination: destination,
      ReadOnly: readOnly,
      BindOptions: { CreateMountpoint: true },
      RW: !readOnly,
    };
  }

  private async configureVolumeMounts(
    createBody: SpecGenerator,
    userConfigValues: McpServerUserConfigValues | null
  ): Promise<void> {
    const mounts: Mount[] = [];
    if (this.serverConfig.inject_file) {
      //  Inject files into the container by creating temporary host files and mounting them
      log.info(
        `Injecting ${Object.keys(this.serverConfig.inject_file).length} files into container ${this.containerName}`
      );
      const tempDir = path.join(os.tmpdir(), `archestra-inject-${this.containerName}-${uuidv4()}`);

      try {
        // Create temp directory
        await fs.promises.mkdir(tempDir, { recursive: true });

        // Create each file and add it as a mount
        for (const [filename, content] of Object.entries(this.serverConfig.inject_file)) {
          const hostFilePath = path.join(tempDir, path.basename(filename));
          const containerFilePath = filename.startsWith('/') ? filename : `/tmp/${filename}`;

          // Write file content to temp location
          await fs.promises.writeFile(hostFilePath, content as string, 'utf-8');
          log.info(`Created inject file: ${hostFilePath} -> ${containerFilePath}`);

          // Add as bind mount to container
          mounts.push(this.buildMount(hostFilePath, containerFilePath, true));
        }

        log.info(`Successfully configured ${Object.keys(this.serverConfig.inject_file).length} file injection mounts`);
      } catch (error) {
        log.error(`Failed to setup file injection for ${this.containerName}:`, error);
        // Clean up temp directory on error
        try {
          await fs.promises.rm(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
          log.error(`Failed to cleanup temp directory ${tempDir}:`, cleanupError);
        }
        throw error;
      }
    }

    // Handle mounts from userConfigValues.allowed_directories
    log.info(
      `Checking userConfigValues for mount configuration: allowed_directories present=${Array.isArray(userConfigValues?.allowed_directories)}, read_only=${parseBoolean(userConfigValues?.read_only)}`
    );
    if (userConfigValues && Array.isArray(userConfigValues.allowed_directories)) {
      log.info(`Processing ${userConfigValues.allowed_directories.length} allowed_directories for mounting`);
      const readOnly = parseBoolean(userConfigValues.read_only);
      for (const hostPathRaw of userConfigValues.allowed_directories) {
        if (typeof hostPathRaw !== 'string' || hostPathRaw.trim() === '') continue;
        const hostPath = hostPathRaw.trim();

        // Mount with a simple sanitized name to avoid conflicts + check that the directory exists
        try {
          const stats = await fs.promises.stat(hostPath);
          if (!stats.isDirectory()) {
            log.warn(`Path is not a directory, skipping: ${hostPath}`);
            continue;
          }
        } catch (error) {
          log.warn(`Directory does not exist, skipping: ${hostPath}`, error);
          continue;
        }

        const baseName = path.basename(hostPath);
        const sanitizedBaseName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const target = path.posix.join(FILE_SYSTEM_BASE_MOUNT_PATH, sanitizedBaseName);

        log.info(`Mount (bind): host="${hostPath}" -> container="${target}" (readOnly=${readOnly})`);
        // Use SpecGenerator Mount shape (capitalized keys)
        mounts.push(this.buildMount(hostPath, target, readOnly));
      }
    } else {
      log.info(
        `No mount configuration: userConfigValues=${!!userConfigValues}, allowed_directories type=${userConfigValues?.allowed_directories ? typeof userConfigValues.allowed_directories : 'undefined'}`
      );
    }
    if (!createBody.mounts) createBody.mounts = [];
    for (const m of mounts) {
      createBody.mounts.push(m);
    }
  }
}
