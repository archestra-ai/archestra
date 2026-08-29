/**
 * Everything the loop needs, read once from the Background execution runtime
 * injected. Nothing here is optional-with-a-guess: a missing value means the
 * pod was started wrong, and failing at startup is far easier to diagnose than
 * an agent that silently talks to the wrong place.
 */
export type BackgroundExecutionAgentConfig = {
  agentId: string;
  agentName: string;
  /** Durable task id used to correlate proxy interactions for this run. */
  taskId: string;
  /** Archestra LLM proxy base, already scoped to the agent. */
  proxyBaseUrl: string;
  /** Virtual key authenticating this session to the proxy. */
  apiKey: string;
  proxyProtocol: "openai_responses" | "openai_chat" | "anthropic";
  /** MCP gateway base, already scoped to the agent. */
  gatewayUrl: string;
  gatewayToken: string;
  model: string;
  /** Interactive Chat terminal, or an unattended task that must settle. */
  executionMode: "interactive" | "one_shot";
  /** Server-rendered, white-label-safe terminal header. */
  banner: string | null;
  /** Agent instructions configured in the platform. */
  systemPrompt: string | null;
  /** Initial instruction, when the session was started with one. */
  task: string | null;
  /** FIFO the control plane writes steer messages into. */
  steerFifo: string;
  maxSteps: number;
  /**
   * How long a finished session waits for further direction before exiting.
   * Null parks forever — for sessions meant to be interactive rather than a
   * task with an end.
   */
  idleTimeoutMs: number | null;
};

export class BackgroundExecutionAgentConfigError extends Error {}

export function readConfig(
  env: NodeJS.ProcessEnv,
): BackgroundExecutionAgentConfig {
  return {
    agentId: requireBackgroundExecutionValue(env, "AGENT_ID"),
    agentName:
      readBackgroundExecutionValue(env, "AGENT_NAME")?.trim() || "agent",
    taskId: requireBackgroundExecutionValue(env, "TASK_ID"),
    proxyBaseUrl: stripTrailingSlash(
      requireValue(env, "ARCHESTRA_LLM_PROXY_URL"),
    ),
    apiKey: requireValue(env, "ARCHESTRA_VIRTUAL_KEY"),
    proxyProtocol: readProxyProtocol(env),
    gatewayUrl: stripTrailingSlash(
      requireValue(env, "ARCHESTRA_MCP_GATEWAY_URL"),
    ),
    gatewayToken: requireValue(env, "ARCHESTRA_MCP_GATEWAY_TOKEN"),
    model:
      readBackgroundExecutionValue(env, "MODEL")?.trim() || "claude-opus-5",
    executionMode: readExecutionMode(env),
    banner: readBackgroundExecutionValue(env, "BANNER")?.trim() || null,
    systemPrompt:
      readBackgroundExecutionValue(env, "SYSTEM_PROMPT")?.trim() || null,
    task: readBackgroundExecutionValue(env, "TASK")?.trim() || null,
    steerFifo:
      readBackgroundExecutionValue(env, "STEER_FIFO")?.trim() ||
      "/var/run/archestra/steer",
    maxSteps: readPositiveInt(
      readBackgroundExecutionValue(env, "MAX_STEPS"),
      500,
    ),
    idleTimeoutMs:
      readPositiveInt(
        readBackgroundExecutionValue(env, "IDLE_TIMEOUT_SECONDS"),
        0,
      ) * 1000 || null,
  };
}

function readExecutionMode(
  env: NodeJS.ProcessEnv,
): BackgroundExecutionAgentConfig["executionMode"] {
  const value = readBackgroundExecutionValue(env, "MODE")?.trim() || "one_shot";
  if (value === "interactive" || value === "one_shot") return value;
  throw new BackgroundExecutionAgentConfigError(
    "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MODE must be interactive or one_shot.",
  );
}

function readProxyProtocol(
  env: NodeJS.ProcessEnv,
): BackgroundExecutionAgentConfig["proxyProtocol"] {
  const value = requireValue(env, "ARCHESTRA_LLM_PROXY_PROTOCOL");
  if (
    value === "openai_responses" ||
    value === "openai_chat" ||
    value === "anthropic"
  ) {
    return value;
  }
  throw new BackgroundExecutionAgentConfigError(
    "ARCHESTRA_LLM_PROXY_PROTOCOL must be openai_responses, openai_chat, or anthropic.",
  );
}

function requireBackgroundExecutionValue(
  env: NodeJS.ProcessEnv,
  suffix: string,
): string {
  const name = `ARCHESTRA_AGENT_BACKGROUND_EXECUTION_${suffix}`;
  const value = readBackgroundExecutionValue(env, suffix)?.trim();
  if (!value) {
    throw new BackgroundExecutionAgentConfigError(
      `${name} is not set. A background run is started by the Archestra runtime, which injects it.`,
    );
  }
  return value;
}

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new BackgroundExecutionAgentConfigError(`${name} is not set.`);
  }
  return value;
}

function readBackgroundExecutionValue(
  env: NodeJS.ProcessEnv,
  suffix: string,
): string | undefined {
  return env[`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_${suffix}`];
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
