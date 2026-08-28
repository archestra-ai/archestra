#!/usr/bin/env node
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type ModelMessage, stepCountIs, streamText } from "ai";
import {
  type BackgroundExecutionAgentConfig,
  BackgroundExecutionAgentConfigError,
  readConfig,
} from "./config.js";
import { loadGatewayTools } from "./gateway-tools.js";
import { loadLocalWorkspaceTools } from "./local-tools.js";
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

  write(`Background execution run for ${config.agentName} (${config.agentId})`);
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
  const shutdown = new AbortController();
  const stop = () => {
    shutdown.abort();
    steerQueue.stop();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  const model = createModel(config);

  const mcpClient = await connectGateway(config);
  const tools = {
    ...loadLocalWorkspaceTools(),
    ...(await loadGatewayTools(mcpClient)),
  };
  write(`${Object.keys(tools).length} tools available.`);
  write("");

  let messages: ModelMessage[] = [];
  if (config.task) {
    messages.push({ role: "user", content: config.task });
  }

  let exitCode = 0;
  try {
    while (!shutdown.signal.aborted) {
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
        model,
        system: config.systemPrompt ?? undefined,
        messages,
        tools,
        stopWhen: stepCountIs(config.maxSteps),
        abortSignal: shutdown.signal,
      });

      let streamFailed = false;
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          process.stdout.write(part.text);
        } else if (part.type === "tool-call") {
          write(`\n[tool] ${part.toolName}`);
        } else if (part.type === "error") {
          // Provider errors may include raw response data. The platform logs
          // carry the detail; terminal scrollback must never echo secrets.
          write("\n[error] The model request failed.");
          streamFailed = true;
        }
      }
      if (streamFailed) {
        throw new Error("Model stream failed");
      }
      write("");
      messages.push(...(await result.response).messages);
      messages = trimHistory(messages);

      // Steers that arrived mid-turn are consumed here, at the boundary, so
      // they join the conversation in order instead of interrupting a call.
      for (const message of steerQueue.drain()) {
        write(`> ${message}`);
        messages.push({ role: "user", content: message });
      }
    }
  } catch {
    if (!shutdown.signal.aborted) {
      // SDK/provider exceptions can carry raw HTTP response bodies. Keep the
      // user-visible terminal generic rather than persisting those details in
      // the run's scrollback and logs.
      write("\narchestra: the session failed.");
      exitCode = 1;
    }
  } finally {
    steerQueue.stop();
    await Promise.race([
      mcpClient.close().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }

  return exitCode;
}

function createModel(config: BackgroundExecutionAgentConfig) {
  if (config.proxyProtocol === "anthropic") {
    return createAnthropic({
      // Claude-compatible clients append `/v1/messages`; the AI SDK appends
      // only `/messages`, so supply its `/v1` segment here.
      baseURL: `${config.proxyBaseUrl}/v1`,
      apiKey: config.apiKey,
    })(config.model);
  }
  const openai = createOpenAI({
    baseURL: config.proxyBaseUrl,
    apiKey: config.apiKey,
  });
  return config.proxyProtocol === "openai_chat"
    ? openai.chat(config.model)
    : openai.responses(config.model);
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

/**
 * Bound long-lived sessions without splitting a user turn from the assistant
 * and tool messages that answer it. The newest complete turns are retained.
 */
function trimHistory(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  const minimumStart = messages.length - MAX_HISTORY_MESSAGES;
  const nextUserTurn = messages.findIndex(
    (message, index) => index >= minimumStart && message.role === "user",
  );
  return nextUserTurn === -1
    ? messages.slice(-MAX_HISTORY_MESSAGES)
    : messages.slice(nextUserTurn);
}

const MAX_HISTORY_MESSAGES = 200;

main()
  .then((code) => {
    process.exit(code);
  })
  .catch(() => {
    write("archestra: the session could not start.");
    process.exitCode = 1;
  });
