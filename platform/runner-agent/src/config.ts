/**
 * Everything the loop needs, read once from the environment the Runner runtime
 * injected. Nothing here is optional-with-a-guess: a missing value means the
 * pod was started wrong, and failing at startup is far easier to diagnose than
 * an agent that silently talks to the wrong place.
 */
export type RunnerAgentConfig = {
  runnerId: string;
  runnerName: string;
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
};

export class RunnerAgentConfigError extends Error {}

export function readConfig(env: NodeJS.ProcessEnv): RunnerAgentConfig {
  return {
    runnerId: require_(env, "ARCHESTRA_RUNNER_ID"),
    runnerName: env.ARCHESTRA_RUNNER_NAME?.trim() || "runner",
    proxyBaseUrl: stripTrailingSlash(require_(env, "ARCHESTRA_LLM_PROXY_URL")),
    apiKey: require_(env, "ANTHROPIC_API_KEY"),
    gatewayUrl: stripTrailingSlash(require_(env, "ARCHESTRA_MCP_GATEWAY_URL")),
    gatewayToken: require_(env, "ARCHESTRA_MCP_GATEWAY_TOKEN"),
    model: env.ARCHESTRA_RUNNER_MODEL?.trim() || "claude-opus-5",
    task: env.ARCHESTRA_RUNNER_TASK?.trim() || null,
    steerFifo:
      env.ARCHESTRA_RUNNER_STEER_FIFO?.trim() || "/var/run/archestra/steer",
    maxSteps: readPositiveInt(env.ARCHESTRA_RUNNER_MAX_STEPS, 500),
  };
}

function require_(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new RunnerAgentConfigError(
      `${name} is not set. A runner is started by the Archestra runtime, which injects it.`,
    );
  }
  return value;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
