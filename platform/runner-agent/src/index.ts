#!/usr/bin/env node
import { createAnthropic } from "@ai-sdk/anthropic";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { stepCountIs, streamText } from "ai";
import {
  type BackgroundExecutionAgentConfig,
  BackgroundExecutionAgentConfigError,
  readConfig,
} from "./config.js";
import { loadGatewayTools } from "./gateway-tools.js";
import { SteerQueue } from "./steer-queue.js";

/**
 * The agent loop that runs inside a Background execution deployment.
 *
 * It is deliberately thin. Everything that decides what the agent may do — the
 * model, the tool set, the policies, the budget — is resolved by the platform
 * behind the proxy and the gateway this process talks to. The loop's own job is
 * to keep a conversation going, surface it legibly to anyone attached to the
 * tmux session, and take direction from a human without losing its place.
 */
async function main(): Promise<number> {
  let config: BackgroundExecutionAgentConfig;
  try {
    config = readConfig(process.env);
  } catch (error: unknown) {
    if (error instanceof BackgroundExecutionAgentConfigError) {
      write(`archestra: ${error.message}`);
      return 78;
    }
    throw error;
  }

  write(`Archestra background run for ${config.agentName} (${config.agentId})`);
  write(
    `Model ${config.model} via the Archestra proxy. Tools from the MCP gateway.`,
  );
  write(
    "Type into this session to steer it; the message lands at the next turn.",
  );
  write("");

  const steerQueue = new SteerQueue(config.steerFifo, (error: unknown) => {
    write(`archestra: could not read the steer channel: ${describe(error)}`);
  });
  steerQueue.start();

  const anthropic = createAnthropic({
    // The injected base is `/v1/anthropic/{agentId}` — the shape a BYO CLI
    // expects in ANTHROPIC_BASE_URL, appending `/v1/messages` itself. The AI
    // SDK appends only `/messages`, so the `/v1` segment is supplied here.
    baseURL: `${config.proxyBaseUrl}/v1`,
    apiKey: config.apiKey,
  });

  const mcpClient = await connectGateway(config);
  const tools = await loadGatewayTools(mcpClient);
  write(`${Object.keys(tools).length} tools available.`);
  write("");

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (config.task) {
    messages.push({ role: "user", content: config.task });
  }

  let exitCode = 0;
  try {
    while (true) {
      if (messages.length === 0 || messages.at(-1)?.role === "assistant") {
        // Nothing to answer. Park on the steer channel rather than spinning —
        // this is what makes a session that is idle for days almost free.
        write("[waiting for direction]");
        const incoming = await steerQueue.waitForMessage(config.idleTimeoutMs);
        if (incoming.length === 0) {
          if (config.idleTimeoutMs !== null) {
            write(
              "[archestra] no further direction — session complete, exiting",
            );
          }
          break;
        }
        for (const message of incoming) {
          write(`> ${message}`);
          messages.push({ role: "user", content: message });
        }
      }

      const result = streamText({
        model: anthropic(config.model),
        system: config.systemPrompt ?? undefined,
        messages,
        tools,
        stopWhen: stepCountIs(config.maxSteps),
      });

      let assistantText = "";
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          assistantText += part.text;
          process.stdout.write(part.text);
        } else if (part.type === "tool-call") {
          write(`\n[tool] ${part.toolName}`);
        } else if (part.type === "error") {
          write(`\n[error] ${describe(part.error)}`);
        }
      }
      write("");
      messages.push({ role: "assistant", content: assistantText });

      // Steers that arrived mid-turn are consumed here, at the boundary, so
      // they join the conversation in order instead of interrupting a call.
      for (const message of steerQueue.drain()) {
        write(`> ${message}`);
        messages.push({ role: "user", content: message });
      }
    }
  } catch (error) {
    write(`\narchestra: the session failed: ${describe(error)}`);
    exitCode = 1;
  } finally {
    steerQueue.stop();
    await mcpClient.close().catch(() => undefined);
  }

  return exitCode;
}

/**
 * The gateway is reached as an ordinary external MCP client, authenticated with
 * the invoking user's own bearer — the pod has no privileged path back into the
 * platform, so its tool access is exactly that person's.
 */
async function connectGateway(
  config: BackgroundExecutionAgentConfig,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(config.gatewayUrl),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${config.gatewayToken}` },
      },
    },
  );
  const client = new Client({
    name: "archestra-runner-agent",
    version: "0.1.0",
  });
  await client.connect(transport);
  return client;
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    write(`archestra: ${describe(error)}`);
    process.exitCode = 1;
  });
