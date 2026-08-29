#!/usr/bin/env node
import { createInterface } from "node:readline";
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
      write(`runner: ${error.message}`);
      return 78;
    }
    throw error;
  }

  renderHeader(config);

  const steerQueue = new SteerQueue(config.steerFifo, (error: unknown) => {
    write(`runner: could not read the steer channel: ${describe(error)}`);
  });
  steerQueue.start();
  const terminalInput =
    config.executionMode === "interactive"
      ? createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: process.stdin.isTTY,
        })
      : null;
  terminalInput?.setPrompt(`${ANSI.accent}›${ANSI.reset} `);
  terminalInput?.on("line", (line) => steerQueue.enqueue(line));
  const shutdown = new AbortController();
  const stop = () => {
    shutdown.abort();
    steerQueue.stop();
    terminalInput?.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  const model = createModel(config);

  let mcpClient: Client;
  try {
    mcpClient = await connectGateway(config);
  } catch (error) {
    stop();
    throw error;
  }
  const tools = {
    ...loadLocalWorkspaceTools(),
    ...(await loadGatewayTools(mcpClient)),
  };
  write(`${Object.keys(tools).length} tools available.`);
  write("");

  let messages: ModelMessage[] = [];
  if (config.task) {
    renderTurn("You", config.task);
    messages.push({ role: "user", content: config.task });
  }

  let exitCode = 0;
  try {
    while (!shutdown.signal.aborted) {
      if (messages.length === 0 || messages.at(-1)?.role === "assistant") {
        // Nothing to answer. Park on the steer channel rather than spinning —
        // this is what makes a session that is idle for days almost free.
        terminalInput?.prompt();
        const incoming = await steerQueue.waitForMessage(config.idleTimeoutMs);
        if (incoming.length === 0) {
          if (config.idleTimeoutMs !== null) {
            write("[runner] no further direction — session complete, exiting");
          }
          break;
        }
        for (const message of incoming) {
          messages.push({ role: "user", content: message });
        }
      }

      process.stdout.write(
        `\n${ANSI.accent}${config.agentName}${ANSI.reset}\n`,
      );
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

      if (config.executionMode === "one_shot") break;

      // Steers that arrived mid-turn are consumed here, at the boundary, so
      // they join the conversation in order instead of interrupting a call.
      for (const message of steerQueue.drain()) {
        messages.push({ role: "user", content: message });
      }
    }
  } catch {
    if (!shutdown.signal.aborted) {
      // SDK/provider exceptions can carry raw HTTP response bodies. Keep the
      // user-visible terminal generic rather than persisting those details in
      // the run's scrollback and logs.
      write("\nrunner: the session failed.");
      exitCode = 1;
    }
  } finally {
    steerQueue.stop();
    terminalInput?.close();
    await Promise.race([
      mcpClient.close().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }

  return exitCode;
}

function renderHeader(config: BackgroundExecutionAgentConfig): void {
  if (config.banner) {
    process.stdout.write(`${ANSI.accent}${config.banner}${ANSI.reset}\n\n`);
  }
  write(`${ANSI.bold}${config.agentName}${ANSI.reset}`);
  write(
    `${ANSI.dim}${config.model} · isolated execution · ${
      config.executionMode === "interactive" ? "interactive" : "one-shot"
    }${ANSI.reset}`,
  );
  if (config.executionMode === "interactive") {
    write(
      `${ANSI.dim}Enter a follow-up at the prompt. Ctrl-C stops.${ANSI.reset}`,
    );
  }
  write("");
}

function renderTurn(label: string, content: string): void {
  write(`${ANSI.accent}${label}${ANSI.reset}`);
  write(content);
  write("");
}

function createModel(config: BackgroundExecutionAgentConfig) {
  const headers = executionHeaders(config.taskId);
  if (config.proxyProtocol === "anthropic") {
    return createAnthropic({
      // Claude-compatible clients append `/v1/messages`; the AI SDK appends
      // only `/messages`, so supply its `/v1` segment here.
      baseURL: `${config.proxyBaseUrl}/v1`,
      apiKey: config.apiKey,
      headers,
    })(config.model);
  }
  const openai = createOpenAI({
    baseURL: config.proxyBaseUrl,
    apiKey: config.apiKey,
    headers,
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
        headers: {
          Authorization: `Bearer ${config.gatewayToken}`,
          ...executionHeaders(config.taskId),
        },
      },
    },
  );
  const client = new Client({
    name: "archestra-runner-agent",
    version: "0.1.0",
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return client;
}

function executionHeaders(taskId: string): Record<string, string> {
  return {
    "X-Archestra-Execution-Id": taskId,
    "X-Archestra-Session-Id": taskId,
  };
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
const ANSI = {
  accent: "\u001b[38;5;42m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  reset: "\u001b[0m",
} as const;

main()
  .then((code) => {
    process.exit(code);
  })
  .catch(() => {
    write("runner: the session could not start.");
    // An MCP transport may retain internal fetch handles after a failed
    // handshake. This is a task process, so a startup failure is terminal: do
    // not leave the execution pod looking alive after surfacing the error.
    process.exit(1);
  });
