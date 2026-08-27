import config from "@/config";
import type { RunnerLaunchSpec } from "@/k8s/runner-runtime/manifests";
import { RUNNER_STEER_FIFO } from "@/k8s/runner-runtime/manifests";
import { constructFrozenRunnerName } from "@/k8s/runner-runtime/naming";
import {
  AgentModel,
  LimitModel,
  LlmProviderApiKeyModel,
  TeamModel,
  UserTokenModel,
  VirtualApiKeyModel,
} from "@/models";
import type {
  AgentDeployment,
  MissingAgentDeploymentCredential,
} from "@/types";
import { AGENT_DEPLOYMENT_CREDENTIALS_REQUIRED_CODE, ApiError } from "@/types";
import { resolveAgentDeploymentCredentials } from "./credentials";

/**
 * Raised when a session cannot start only because the person it would act as
 * has not supplied credentials the Agent declares. Carries the list so every
 * surface can name exactly what to add instead of reporting an opaque failure.
 */
class AgentDeploymentCredentialsRequiredError extends ApiError {
  readonly code = AGENT_DEPLOYMENT_CREDENTIALS_REQUIRED_CODE;
  readonly agentId: string;
  readonly missing: MissingAgentDeploymentCredential[];

  constructor(agentId: string, missing: MissingAgentDeploymentCredential[]) {
    super(
      409,
      `This Agent's background execution needs credentials you have not set up yet: ${missing
        .map((entry) => entry.label)
        .join(", ")}`,
    );
    this.name = "AgentDeploymentCredentialsRequiredError";
    this.agentId = agentId;
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
  deployment: AgentDeployment;
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
  const platformBaseUrl =
    config.agentBackgroundExecution.platformBaseUrl.replace(/\/+$/, "");
  if (!platformBaseUrl) {
    // Refusing beats starting a session that would call providers directly,
    // outside every policy and cost record the proxy exists to keep.
    throw new ApiError(
      500,
      "Background execution requires ARCHESTRA_AGENT_BACKGROUND_EXECUTION_PLATFORM_BASE_URL (or ARCHESTRA_INTERNAL_API_BASE_URL) so the run can reach the LLM proxy and MCP gateway",
    );
  }

  const credentials = await resolveAgentDeploymentCredentials({
    deployment: params.deployment,
    organizationId: params.organizationId,
    userId: params.actorUserId,
  });
  if (credentials.misconfigured.length > 0) {
    throw new ApiError(
      409,
      `This Agent's background execution is missing shared credentials an administrator must configure: ${credentials.misconfigured
        .map((entry) => entry.label)
        .join(", ")}`,
    );
  }
  if (credentials.missing.length > 0) {
    throw new AgentDeploymentCredentialsRequiredError(
      params.deployment.agentId,
      credentials.missing,
    );
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

  // The virtual key must carry a provider mapping or the proxy refuses it:
  // a virtual key is an indirection to a real provider credential, not a
  // credential itself. Resolution honors the agent's configured key first,
  // then the actor's personal -> team -> org precedence, exactly as chat does.
  const agent = await AgentModel.findById(params.agentId);
  const userTeamIds = await TeamModel.getUserTeamIds(params.actorUserId);
  const providerApiKey = await LlmProviderApiKeyModel.getCurrentApiKey({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    userTeamIds,
    provider: "anthropic",
    conversationId: null,
    agentLlmApiKeyId: agent?.llmApiKeyId ?? undefined,
  });
  if (!providerApiKey) {
    throw new ApiError(
      409,
      "No Anthropic API key is configured for your account, teams, or organization, so this background run has nothing to talk to the model with. Ask an admin to add one under LLM provider keys.",
    );
  }

  const virtualKey = await VirtualApiKeyModel.create({
    organizationId: params.organizationId,
    name: `background-task-${params.taskId.slice(0, 8)}`,
    // Personal scope is what attributes the session's LLM spend to the human
    // it acts as rather than to the organization at large.
    scope: "personal",
    authorId: params.actorUserId,
    providerApiKeys: [
      { provider: "anthropic", providerApiKeyId: providerApiKey.id },
    ],
  });
  if (params.deployment.maxCostUsd) {
    try {
      await LimitModel.create({
        entityType: "virtual_key",
        entityId: virtualKey.virtualKey.id,
        limitType: "token_cost",
        limitValue: params.deployment.maxCostUsd,
        model: null,
        cleanupInterval: "1m",
      });
    } catch (error) {
      await VirtualApiKeyModel.delete(virtualKey.virtualKey.id);
      throw error;
    }
  }

  // The singleton proxy endpoint, the same one every external client uses.
  // Spend attribution rides the personal virtual key; an agent-scoped URL is
  // not a thing the single-proxy design supports for chat agents.
  const proxyUrl = `${platformBaseUrl}/v1/anthropic`;
  const nonSecretEnv: Record<string, string> = {
    // The runner's own environment goes first: the addresses below must win.
    // An entry overriding ANTHROPIC_BASE_URL would be exactly the bypass the
    // platform-URL guard above exists to prevent.
    ...Object.fromEntries(
      (params.deployment.environment ?? []).map(({ key, value }) => [
        key,
        value,
      ]),
    ),
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_AGENT_ID: params.deployment.agentId,
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_AGENT_NAME: agent?.name ?? "agent",
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK_ID: params.taskId,
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_STEER_FIFO: RUNNER_STEER_FIFO,
    // The finish contract: a session that has done its work parks this long
    // for further direction, then exits so the Job — and the task — settle.
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_IDLE_TIMEOUT_SECONDS: String(
      (params.deployment.idleTimeoutMinutes ??
        config.agentBackgroundExecution.defaultIdleTimeoutMinutes) * 60,
    ),
    ARCHESTRA_LLM_PROXY_URL: proxyUrl,
    ANTHROPIC_BASE_URL: proxyUrl,
    ARCHESTRA_MCP_GATEWAY_URL: `${platformBaseUrl}/v1/mcp/${params.agentId}`,
  };

  const secretEnv: Record<string, string> = {
    ARCHESTRA_MCP_GATEWAY_TOKEN: gatewayToken,
    ARCHESTRA_VIRTUAL_KEY: virtualKey.value,
    // Both the Archestra runner-agent and bring-your-own CLIs read the provider
    // variables, so the virtual key is presented that way too.
    ANTHROPIC_API_KEY: virtualKey.value,
    ANTHROPIC_AUTH_TOKEN: virtualKey.value,
    ...(agent?.systemPrompt
      ? {
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_SYSTEM_PROMPT:
            agent.systemPrompt,
        }
      : {}),
    ...(params.task
      ? { ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK: params.task }
      : {}),
    ...credentials.env,
  };

  return {
    virtualApiKeyId: virtualKey.virtualKey.id,
    spec: {
      taskId: params.taskId,
      runnerId: params.deployment.agentId,
      frozenName: constructFrozenRunnerName(
        agent?.name ?? "agent",
        params.taskId,
      ),
      namespace: params.namespace,
      image: params.deployment.image,
      command: params.deployment.command ?? null,
      privileged: params.deployment.privileged,
      resources: params.deployment.resources ?? {
        cpuRequest: config.agentBackgroundExecution.resources.cpuRequest,
        memoryRequest: config.agentBackgroundExecution.resources.memoryRequest,
        memoryLimit: config.agentBackgroundExecution.resources.memoryLimit,
      },
      env: nonSecretEnv,
      secretEnv,
      activeDeadlineSeconds:
        (params.deployment.ttlHours ??
          config.agentBackgroundExecution.defaultTtlHours) *
        60 *
        60,
      imagePullSecrets: params.imagePullSecrets ?? [],
      ownerReferences: params.ownerReferences,
    },
  };
}
