import config from "@/config";
import type { RunnerLaunchSpec } from "@/k8s/runner-runtime/manifests";
import { RUNNER_STEER_FIFO } from "@/k8s/runner-runtime/manifests";
import { constructFrozenRunnerName } from "@/k8s/runner-runtime/naming";
import { UserTokenModel, VirtualApiKeyModel } from "@/models";
import type { Agent, MissingRunnerCredential, Runner } from "@/types";
import { ApiError, RUNNER_CREDENTIALS_REQUIRED_CODE } from "@/types";
import { resolveRunnerCredentials } from "./credentials";

/**
 * Raised when a runner cannot start only because the invoking user has not
 * supplied credentials the agent declares. Carries the list so every surface —
 * the spawn dialog, the MCP tool's reply, the ChatOps thread — can name exactly
 * what to add instead of reporting an opaque failure.
 */
export class RunnerCredentialsRequiredError extends ApiError {
  readonly code = RUNNER_CREDENTIALS_REQUIRED_CODE;
  readonly missing: MissingRunnerCredential[];

  constructor(missing: MissingRunnerCredential[]) {
    super(
      409,
      `This agent needs credentials you have not set up yet: ${missing
        .map((entry) => entry.label)
        .join(", ")}`,
    );
    this.name = "RunnerCredentialsRequiredError";
    this.missing = missing;
  }
}

/**
 * Build everything a runner pod needs, resolved for one user.
 *
 * The point of this function is that a runner needs no proxy or gateway
 * configuration of its own: the LLM proxy URL, a personal-scope virtual key
 * (so spend attributes to the human rather than a shared organization
 * credential) and the user's MCP gateway bearer are all derived here from the
 * invoking identity.
 */
export async function buildRunnerLaunchSpec(params: {
  runner: Runner;
  agent: Pick<Agent, "id" | "runnerConfig" | "runnerSecretId">;
  namespace: string;
  imagePullSecrets?: string[];
  ownerReferences?: RunnerLaunchSpec["ownerReferences"];
}): Promise<{ spec: RunnerLaunchSpec; virtualApiKeyId: string }> {
  const { runner, agent } = params;
  const platformBaseUrl = config.runners.platformBaseUrl.replace(/\/+$/, "");
  if (!platformBaseUrl) {
    // Refusing beats starting a session that would silently call providers
    // directly, outside every policy and cost record the proxy exists to keep.
    throw new ApiError(
      500,
      "Runners require ARCHESTRA_RUNNERS_PLATFORM_BASE_URL (or ARCHESTRA_INTERNAL_API_BASE_URL) so the session can reach the LLM proxy and MCP gateway",
    );
  }

  const credentials = await resolveRunnerCredentials({
    agent,
    organizationId: runner.organizationId,
    userId: runner.createdByUserId,
  });
  if (credentials.misconfigured.length > 0) {
    throw new ApiError(
      409,
      `This agent is missing shared credentials an administrator must configure: ${credentials.misconfigured
        .map((entry) => entry.label)
        .join(", ")}`,
    );
  }
  if (credentials.missing.length > 0) {
    throw new RunnerCredentialsRequiredError(credentials.missing);
  }

  const userToken = await UserTokenModel.ensureUserToken(
    runner.createdByUserId,
    runner.organizationId,
  );
  const gatewayToken = await UserTokenModel.getTokenValue(userToken.id);
  if (!gatewayToken) {
    throw new ApiError(
      500,
      "Could not resolve the MCP gateway token for this user",
    );
  }

  const virtualKey = await VirtualApiKeyModel.create({
    organizationId: runner.organizationId,
    name: `runner-${runner.id.slice(0, 8)}`,
    // Personal scope is what attributes the session's LLM spend to the human
    // who started it rather than to the organization at large.
    scope: "personal",
    authorId: runner.createdByUserId,
  });

  const proxyUrl = `${platformBaseUrl}/v1/anthropic/${runner.agentId}`;
  const nonSecretEnv: Record<string, string> = {
    ARCHESTRA_RUNNER_ID: runner.id,
    ARCHESTRA_RUNNER_NAME: runner.name,
    ARCHESTRA_RUNNER_STEER_FIFO: RUNNER_STEER_FIFO,
    ARCHESTRA_LLM_PROXY_URL: proxyUrl,
    ANTHROPIC_BASE_URL: proxyUrl,
    ARCHESTRA_MCP_GATEWAY_URL: `${platformBaseUrl}/v1/mcp/${runner.agentId}`,
    ...(runner.task ? { ARCHESTRA_RUNNER_TASK: runner.task } : {}),
    ...Object.fromEntries(
      (agent.runnerConfig?.environment ?? []).map(({ key, value }) => [
        key,
        value,
      ]),
    ),
  };

  const secretEnv: Record<string, string> = {
    ARCHESTRA_MCP_GATEWAY_TOKEN: gatewayToken,
    ARCHESTRA_VIRTUAL_KEY: virtualKey.value,
    // Both the Archestra runner-agent and bring-your-own CLIs (Claude Code)
    // read the provider variables, so the virtual key is presented that way too.
    ANTHROPIC_API_KEY: virtualKey.value,
    ANTHROPIC_AUTH_TOKEN: virtualKey.value,
    ...credentials.env,
  };

  return {
    virtualApiKeyId: virtualKey.virtualKey.id,
    spec: {
      runnerId: runner.id,
      frozenName:
        runner.deploymentName ??
        constructFrozenRunnerName(runner.name, runner.id),
      namespace: params.namespace,
      image: runner.image,
      command: runner.command ?? null,
      privileged: runner.privileged,
      resources: runner.resources ?? {
        cpuRequest: config.runners.resources.cpuRequest,
        memoryRequest: config.runners.resources.memoryRequest,
        memoryLimit: config.runners.resources.memoryLimit,
      },
      env: nonSecretEnv,
      secretEnv,
      activeDeadlineSeconds: runner.ttlHours ? runner.ttlHours * 60 * 60 : null,
      imagePullSecrets: params.imagePullSecrets ?? [],
      ownerReferences: params.ownerReferences,
    },
  };
}
