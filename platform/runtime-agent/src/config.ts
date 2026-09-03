/**
 * Everything the loop needs, read once from the Agent Runtime environment
 * injected. Nothing here is optional-with-a-guess: a missing value means the
 * pod was started wrong, and failing at startup is far easier to diagnose than
 * an agent that silently talks to the wrong place.
 */
export type RuntimeAgentConfig = {
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
  runMode: "interactive" | "one_shot";
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

export class RuntimeAgentConfigError extends Error {}

export function readConfig(env: NodeJS.ProcessEnv): RuntimeAgentConfig {
  return {
    agentId: requireAgentRuntimeValue(env, "AGENT_ID"),
    agentName: readAgentRuntimeValue(env, "AGENT_NAME")?.trim() || "agent",
    taskId: requireAgentRuntimeValue(env, "TASK_ID"),
    proxyBaseUrl: stripTrailingSlash(
      requireValue(env, "ARCHESTRA_LLM_PROXY_URL"),
    ),
    apiKey: requireValue(env, "ARCHESTRA_VIRTUAL_KEY"),
    proxyProtocol: readProxyProtocol(env),
    gatewayUrl: stripTrailingSlash(
      requireValue(env, "ARCHESTRA_MCP_GATEWAY_URL"),
    ),
    gatewayToken: requireValue(env, "ARCHESTRA_MCP_GATEWAY_TOKEN"),
    model: readAgentRuntimeValue(env, "MODEL")?.trim() || "claude-opus-5",
    runMode: readRunMode(env),
    banner: readAgentRuntimeValue(env, "BANNER")?.trim() || null,
    systemPrompt: readAgentRuntimeValue(env, "SYSTEM_PROMPT")?.trim() || null,
    task: readAgentRuntimeValue(env, "TASK")?.trim() || null,
    steerFifo:
      readAgentRuntimeValue(env, "STEER_FIFO")?.trim() ||
      "/var/run/archestra/steer",
    maxSteps: readPositiveInt(readAgentRuntimeValue(env, "MAX_STEPS"), 500),
    idleTimeoutMs:
      readPositiveInt(readAgentRuntimeValue(env, "IDLE_TIMEOUT_SECONDS"), 0) *
        1000 || null,
  };
}

function readRunMode(env: NodeJS.ProcessEnv): RuntimeAgentConfig["runMode"] {
  const value = readAgentRuntimeValue(env, "MODE")?.trim() || "one_shot";
  if (value === "interactive" || value === "one_shot") return value;
  throw new RuntimeAgentConfigError(
    "ARCHESTRA_AGENT_RUNTIME_MODE must be interactive or one_shot.",
  );
}

function readProxyProtocol(
  env: NodeJS.ProcessEnv,
): RuntimeAgentConfig["proxyProtocol"] {
  const value = requireValue(env, "ARCHESTRA_LLM_PROXY_PROTOCOL");
  if (
    value === "openai_responses" ||
    value === "openai_chat" ||
    value === "anthropic"
  ) {
    return value;
  }
  throw new RuntimeAgentConfigError(
    "ARCHESTRA_LLM_PROXY_PROTOCOL must be openai_responses, openai_chat, or anthropic.",
  );
}

function requireAgentRuntimeValue(
  env: NodeJS.ProcessEnv,
  suffix: string,
): string {
  const name = `ARCHESTRA_AGENT_RUNTIME_${suffix}`;
  const value = readAgentRuntimeValue(env, suffix)?.trim();
  if (!value) {
    throw new RuntimeAgentConfigError(
      `${name} is not set. An Agent Runtime run is started by Archestra, which injects it.`,
    );
  }
  return value;
}

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new RuntimeAgentConfigError(`${name} is not set.`);
  }
  return value;
}

function readAgentRuntimeValue(
  env: NodeJS.ProcessEnv,
  suffix: string,
): string | undefined {
  return env[`ARCHESTRA_AGENT_RUNTIME_${suffix}`];
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
