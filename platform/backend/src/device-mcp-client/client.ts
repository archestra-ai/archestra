import { createHash } from "node:crypto";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type DeviceMcpConfig,
  DeviceMcpConfigSchema,
} from "@archestra/shared/device-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { deviceMcpChildEnvironment } from "./child-environment";

const MAX_COMMANDS_PER_SESSION = 10_000;
const CommandSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  expiresAt: z.string().datetime(),
});
const InspectionSchema = z.object({
  config: DeviceMcpConfigSchema,
  configDigest: z.string(),
});
const RedemptionSchema = InspectionSchema.extend({
  deviceId: z.string(),
  token: z.string(),
});

type Platform = "darwin" | "win32";

class RelayError extends Error {
  constructor(readonly status: number) {
    super(
      `Device connection request failed (${status}). Reconnect from the registry if access was revoked or configuration changed.`,
    );
  }
}

/** A foreground, user-session companion. It opens no listening socket and stores no credentials. */
export class DeviceMcpCompanion {
  private token: string | null = null;
  private config: DeviceMcpConfig | null = null;
  private configDigest: string | null = null;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private localProcessStopped = false;

  constructor(
    private readonly serverUrl: string,
    private readonly platform: Platform = supportedPlatform(process.platform),
    private readonly report: (message: string) => void = () => {},
  ) {
    validateServerUrl(serverUrl);
  }

  async pair(
    code: string,
    approve: (details: {
      config: DeviceMcpConfig;
      configDigest: string;
      launch: DeviceMcpConfig["platforms"][Platform];
    }) => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<void> {
    const inspection = InspectionSchema.parse(
      await this.request("inspect", { code }, signal),
    );
    const digest = configurationDigest(inspection.config);
    if (digest !== inspection.configDigest) {
      throw new Error(
        "The launch configuration digest did not match. Pair again from the registry.",
      );
    }
    const launch = inspection.config.platforms[this.platform];
    validateLaunch(launch.command, this.platform);
    if (!(await approve({ ...inspection, launch }))) {
      throw new Error(
        "Device pairing cancelled. No credential was issued and no process was launched.",
      );
    }
    const redemption = RedemptionSchema.parse(
      await this.request(
        "redeem",
        {
          code,
          configDigest: digest,
          platform: this.platform,
          protocolVersion: 1,
        },
        signal,
      ),
    );
    if (
      redemption.configDigest !== digest ||
      configurationDigest(redemption.config) !== digest
    ) {
      throw new Error(
        "The launch configuration changed during pairing. Pair again and review the new configuration.",
      );
    }
    this.config = redemption.config;
    this.configDigest = digest;
    this.token = redemption.token;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (!this.token || !this.config || !this.configDigest) {
      throw new Error("Pair this device before starting the connection.");
    }
    let restartDelay = 1_000;
    try {
      while (!signal.aborted) {
        try {
          await this.startLocalServer(signal);
          const { sessionId } = z.object({ sessionId: z.string() }).parse(
            await this.request(
              "session",
              {
                protocolVersion: 1,
                configDigest: this.configDigest,
              },
              signal,
            ),
          );
          this.report(
            "Device MCP is ready. Keep this process running in your signed-in user session.",
          );
          restartDelay = 1_000;
          await this.serveSession(sessionId, signal);
        } catch (error) {
          if (signal.aborted) break;
          if (!this.localProcessStopped || error instanceof RelayError)
            throw error;
          this.report(
            "The MCP process stopped. Restarting the approved configuration; interrupted calls will not be replayed.",
          );
        } finally {
          await this.closeLocalServer();
        }
        await delay(restartDelay, undefined, { signal });
        restartDelay = Math.min(restartDelay * 2, 30_000);
      }
    } finally {
      await this.closeLocalServer();
      this.token = null;
    }
  }

  private async startLocalServer(signal: AbortSignal): Promise<void> {
    if (!this.config) throw new Error("Missing launch configuration");
    const launch = this.config.platforms[this.platform];
    validateLaunch(launch.command, this.platform);
    this.localProcessStopped = false;
    const client = new Client({
      name: "device-mcp-companion",
      version: "0.1.0",
    });
    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      // Do not inherit application credentials or forward relay credentials.
      // The SDK supplies only its small OS environment allowlist.
      env: deviceMcpChildEnvironment(this.platform, process.env),
      stderr: "pipe",
      maxBufferSize: 4 * 1024 * 1024,
    });
    this.client = client;
    this.transport = transport;
    // Drain stderr without uploading it or mixing potentially sensitive output
    // into setup instructions. An administrator can run the reviewed command
    // directly when local diagnosis is necessary.
    transport.stderr?.on("data", () => {});
    client.onclose = () => {
      this.localProcessStopped = true;
    };
    await client.connect(transport, { signal, timeout: 15_000 });
    const actualTools: Tool[] = [];
    const discoverySignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(30_000),
    ]);
    const cursors = new Set<string>();
    let pages = 0;
    let cursor: string | undefined;
    do {
      if (++pages > 128)
        throw new Error("MCP tool discovery exceeded the page limit.");
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        signal: discoverySignal,
        timeout: 15_000,
      });
      actualTools.push(...page.tools);
      if (actualTools.length > 1024)
        throw new Error(
          "The MCP server exposes more tools than the approved manifest.",
        );
      cursor = page.nextCursor;
      if (cursor) {
        if (cursors.has(cursor))
          throw new Error("MCP tool discovery returned a repeated cursor.");
        cursors.add(cursor);
      }
    } while (cursor);
    if (
      actualTools.length !== this.config.tools.length ||
      this.config.tools.some((approved) => {
        const actual = actualTools.find((tool) => tool.name === approved.name);
        return (
          !actual ||
          stableJson(actual.inputSchema) !== stableJson(approved.inputSchema)
        );
      })
    ) {
      throw new Error(
        "The MCP server tools do not match the approved registry manifest. Review the server version and reconnect.",
      );
    }
  }

  private async serveSession(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    // No eviction: a duplicate command can never become executable again in a
    // long-lived process. Renewing a session starts a new bounded generation.
    const executed = new Set<string>();
    let failureDelay = 1_000;
    while (!signal.aborted) {
      if (this.localProcessStopped)
        throw new Error("The local MCP process stopped");
      let command: z.infer<typeof CommandSchema> | null;
      try {
        const response = z
          .object({ command: CommandSchema.nullable() })
          .parse(
            await this.request("poll", { sessionId, ready: true }, signal),
          );
        command = response.command;
        failureDelay = 1_000;
      } catch (error) {
        if (signal.aborted || error instanceof RelayError) throw error;
        this.report(
          "Connection interrupted. Waiting to reconnect; tool execution is not retried.",
        );
        await delay(failureDelay, undefined, { signal });
        failureDelay = Math.min(failureDelay * 2, 10_000);
        continue;
      }
      if (!command) {
        await delay(1_000, undefined, { signal });
        continue;
      }
      if (executed.has(command.id))
        throw new Error(
          "The relay attempted to redeliver an already executed command. Reconnect the device.",
        );
      if (executed.size >= MAX_COMMANDS_PER_SESSION)
        throw new Error(
          "Device session command limit reached. Reconnect the device.",
        );
      executed.add(command.id);
      if (Date.parse(command.expiresAt) <= Date.now()) continue;
      if (!this.config?.tools.some((tool) => tool.name === command.toolName)) {
        throw new Error(
          "The relay requested a tool outside the approved manifest.",
        );
      }
      const heartbeatAbort = new AbortController();
      const heartbeatSignal = AbortSignal.any([signal, heartbeatAbort.signal]);
      const heartbeat = this.keepAlive(sessionId, heartbeatSignal);
      let result: z.infer<typeof CallToolResultSchema>;
      try {
        if (!this.client)
          throw new Error("The local MCP process is not connected");
        result = CallToolResultSchema.parse(
          await this.client.callTool(
            { name: command.toolName, arguments: command.arguments },
            CallToolResultSchema,
            {
              signal,
              timeout: Math.max(
                1,
                Math.min(30_000, Date.parse(command.expiresAt) - Date.now()),
              ),
            },
          ),
        );
      } catch {
        result = {
          isError: true,
          content: [
            {
              type: "text",
              text: "The device MCP call did not complete. Its outcome may be unknown; do not automatically retry a command that may have side effects.",
            },
          ],
        };
      } finally {
        heartbeatAbort.abort();
        await heartbeat;
      }
      // Only result delivery is retried. The MCP call above executes once.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.request(
            "result",
            { sessionId, commandId: command.id, result },
            signal,
          );
          break;
        } catch (error) {
          if (signal.aborted || error instanceof RelayError) throw error;
          if (attempt === 2) {
            this.report(
              "The tool ran, but its result could not be delivered. The outcome is unknown to the caller; it will not be replayed.",
            );
            break;
          }
          await delay(1_000 * (attempt + 1), undefined, { signal });
        }
      }
    }
  }

  private async keepAlive(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await delay(2_000, undefined, { signal });
        await this.request("poll", { sessionId, ready: false }, signal);
      } catch {
        // The result route rechecks revocation/session generation before
        // accepting anything. Never replay an interrupted local operation.
      }
    }
  }

  private async closeLocalServer(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
  }

  private async request(
    action: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await fetch(
      new URL(`/api/device-mcp/${action}`, this.serverUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(10_000),
          ...(signal ? [signal] : []),
        ]),
      },
    );
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500)
        throw new RelayError(response.status);
      throw new Error("The device relay is temporarily unavailable");
    }
    return response.json();
  }
}

function configurationDigest(config: DeviceMcpConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(DeviceMcpConfigSchema.parse(config)))
    .digest("hex");
}

function supportedPlatform(platform: string): Platform {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("The device MCP companion supports macOS and Windows.");
  }
  return platform;
}

function validateServerUrl(serverUrl: string): void {
  const url = new URL(serverUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    throw new Error(
      "Use an HTTPS deployment origin. HTTP is allowed only for a loopback development server.",
    );
  }
}

function validateLaunch(command: string, platform: Platform): void {
  const executable = basename(command.replaceAll("\\", "/")).toLowerCase();
  if (
    /^(?:sh|bash|zsh|dash|fish|cmd|powershell|pwsh)(?:\.exe)?$/.test(
      executable,
    ) ||
    /\.(?:cmd|bat)$/i.test(command)
  ) {
    throw new Error(
      "Launch a native MCP executable directly. Shell commands and batch wrappers are not supported.",
    );
  }
  if (platform === "win32" && !/\.exe$/i.test(command)) {
    throw new Error(
      "Windows launch configuration must name a native .exe, such as node.exe followed by a reviewed script path.",
    );
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_, current) =>
    current && typeof current === "object" && !Array.isArray(current)
      ? Object.fromEntries(
          Object.entries(current).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : current,
  );
}
