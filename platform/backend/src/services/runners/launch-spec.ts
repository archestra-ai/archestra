import config from "@/config";
import type { RunnerLaunchSpec } from "@/k8s/runner-runtime/manifests";
import { RUNNER_STEER_FIFO } from "@/k8s/runner-runtime/manifests";
import { constructFrozenRunnerName } from "@/k8s/runner-runtime/naming";
import { UserTokenModel, VirtualApiKeyModel } from "@/models";
import type { MissingRunnerCredential, Runner } from "@/types";
import { ApiError, RUNNER_CREDENTIALS_REQUIRED_CODE } from "@/types";
import { resolveRunnerCredentials } from "./credentials";

/**
 * Raised when a session cannot start only because the person it would act as
 * has not supplied credentials the runner declares. Carries the list so every
 * surface can name exactly what to add instead of reporting an opaque failure.
 */
class RunnerCredentialsRequiredError extends ApiError {
  readonly code = RUNNER_CREDENTIALS_REQUIRED_CODE;
  readonly missing: MissingRunnerCredential[];

  constructor(missing: MissingRunnerCredential[]) {
    super(
      409,
      `This runner needs credentials you have not set up yet: ${missing
        .map((entry) => entry.label)
        .join(", ")}`,
    );
    this.name = "RunnerCredentialsRequiredError";
    this.missing = missing;
  }
}

/**
 * Everything a pod needs to carry one A2A task, resolved for the person the
 * session acts as.
 *
 * A session needs no proxy or gateway configuration of its own: the LLM proxy
 * URL, a personal-scope virtual key (so spend attributes to the human rather
 * than a shared organization credential) and that user's MCP gateway bearer
 * are all derived from the acting identity.
 */
export async function buildRunnerLaunchSpec(params: {
  runner: Runner;
  /** The A2A task this pod carries; its id names the workload. */
  taskId: string;
  /** Agent the task belongs to, for the proxy and gateway routes. */
  agentId: string;
  actorUserId: string;
  organizationId: string;
  namespace: string;
  /** The first instruction, when the task started with one. */
  task?: string | null;
  imagePullSecrets?: string[];
  ownerReferences?: RunnerLaunchSpec["ownerReferences"];
}): Promise<{ spec: RunnerLaunchSpec; virtualApiKeyId: string }> {
  const platformBaseUrl = config.runners.platformBaseUrl.replace(/\/+$/, "");
  if (!platformBaseUrl) {
    // Refusing beats starting a session that would call providers directly,
    // outside every policy and cost record the proxy exists to keep.
    throw new ApiError(
      500,
      "Runners require ARCHESTRA_RUNNERS_PLATFORM_BASE_URL (or ARCHESTRA_INTERNAL_API_BASE_URL) so the session can reach the LLM proxy and MCP gateway",
    );
  }

  const credentials = await resolveRunnerCredentials({
    runner: params.runner,
    organizationId: params.organizationId,
    userId: params.actorUserId,
  });
  if (credentials.misconfigured.length > 0) {
    throw new ApiError(
      409,
      `This runner is missing shared credentials an administrator must configure: ${credentials.misconfigured
        .map((entry) => entry.label)
        .join(", ")}`,
    );
  }
  if (credentials.missing.length > 0) {
    throw new RunnerCredentialsRequiredError(credentials.missing);
  }

  const userToken = await UserTokenModel.ensureUserToken(
    params.actorUserId,
    params.organizationId,
  );
  const gatewayToken = await UserTokenModel.getTokenValue(userToken.id);
  if (!gatewayToken) {
    throw new ApiError(
      500,
      "Could not resolve the MCP gateway token for this user",
    );
  }

  const virtualKey = await VirtualApiKeyModel.create({
    organizationId: params.organizationId,
    name: `runner-${params.taskId.slice(0, 8)}`,
    // Personal scope is what attributes the session's LLM spend to the human
    // it acts as rather than to the organization at large.
    scope: "personal",
    authorId: params.actorUserId,
  });

  const proxyUrl = `${platformBaseUrl}/v1/anthropic/${params.agentId}`;
  const nonSecretEnv: Record<string, string> = {
    // The runner's own environment goes first: the addresses below must win.
    // An entry overriding ANTHROPIC_BASE_URL would be exactly the bypass the
    // platform-URL guard above exists to prevent.
    ...Object.fromEntries(
      (params.runner.environment ?? []).map(({ key, value }) => [key, value]),
    ),
    ARCHESTRA_RUNNER_ID: params.runner.id,
    ARCHESTRA_RUNNER_NAME: params.runner.name,
    ARCHESTRA_RUNNER_TASK_ID: params.taskId,
    ARCHESTRA_RUNNER_STEER_FIFO: RUNNER_STEER_FIFO,
    ARCHESTRA_LLM_PROXY_URL: proxyUrl,
    ANTHROPIC_BASE_URL: proxyUrl,
    ARCHESTRA_MCP_GATEWAY_URL: `${platformBaseUrl}/v1/mcp/${params.agentId}`,
    ...(params.task ? { ARCHESTRA_RUNNER_TASK: params.task } : {}),
  };

  const secretEnv: Record<string, string> = {
    ARCHESTRA_MCP_GATEWAY_TOKEN: gatewayToken,
    ARCHESTRA_VIRTUAL_KEY: virtualKey.value,
    // Both the Archestra runner-agent and bring-your-own CLIs read the provider
    // variables, so the virtual key is presented that way too.
    ANTHROPIC_API_KEY: virtualKey.value,
    ANTHROPIC_AUTH_TOKEN: virtualKey.value,
    ...credentials.env,
  };

  return {
    virtualApiKeyId: virtualKey.virtualKey.id,
    spec: {
      taskId: params.taskId,
      runnerId: params.runner.id,
      frozenName: constructFrozenRunnerName(params.runner.name, params.taskId),
      namespace: params.namespace,
      image: params.runner.image,
      command: params.runner.command ?? null,
      privileged: params.runner.privileged,
      resources: params.runner.resources ?? {
        cpuRequest: config.runners.resources.cpuRequest,
        memoryRequest: config.runners.resources.memoryRequest,
        memoryLimit: config.runners.resources.memoryLimit,
      },
      env: nonSecretEnv,
      secretEnv,
      activeDeadlineSeconds: params.runner.ttlHours
        ? params.runner.ttlHours * 60 * 60
        : null,
      imagePullSecrets: params.imagePullSecrets ?? [],
      ownerReferences: params.ownerReferences,
    },
  };
}
