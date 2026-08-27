/**
 * Everything the loop needs, read once from the Background execution runtime
 * injected. Nothing here is optional-with-a-guess: a missing value means the
 * pod was started wrong, and failing at startup is far easier to diagnose than
 * an agent that silently talks to the wrong place.
 */
export type BackgroundExecutionAgentConfig = {
  agentId: string;
  agentName: string;
  /** Archestra LLM proxy base, already scoped to the agent. */
  proxyBaseUrl: string;
  /** Virtual key authenticating this session to the proxy. */
  apiKey: string;
  /** MCP gateway base, already scoped to the agent. */
  gatewayUrl: string;
  gatewayToken: string;
  model: string;
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
    proxyBaseUrl: stripTrailingSlash(
      requireValue(env, "ARCHESTRA_LLM_PROXY_URL"),
    ),
    apiKey: requireValue(env, "ANTHROPIC_API_KEY"),
    gatewayUrl: stripTrailingSlash(
      requireValue(env, "ARCHESTRA_MCP_GATEWAY_URL"),
    ),
    gatewayToken: requireValue(env, "ARCHESTRA_MCP_GATEWAY_TOKEN"),
    model:
      readBackgroundExecutionValue(env, "MODEL")?.trim() || "claude-opus-5",
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
