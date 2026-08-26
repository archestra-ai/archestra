import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import { runnerRuntimeManager } from "@/k8s/runner-runtime";
import logger from "@/logging";
import {
  AgentModel,
  EnvironmentModel,
  OrganizationModel,
  RunnerEventModel,
  RunnerModel,
} from "@/models";
import { resolveTrustedImageRegistries } from "@/services/environments/environment";
import { type Agent, ApiError, type Runner } from "@/types";
import { imageMatchesTrustedRegistries } from "@/utils/match-image-against-registries";
import { buildRunnerLaunchSpec } from "./launch-spec";

/**
 * Start a runner for an agent on a user's behalf.
 *
 * Shared by every surface that can start one — the REST route, the Archestra
 * MCP tool, and ChatOps — so the identity rules and failure handling cannot
 * drift between them. The caller's identity is always passed in by the surface
 * that authenticated it, never taken from model-supplied arguments.
 */
export async function startRunner(params: {
  agentId: string;
  organizationId: string;
  userId: string;
  name: string;
  task?: string;
}): Promise<Runner> {
  const agent = await requireRunnableAgent(
    params.agentId,
    params.organizationId,
  );
  const runnerConfig = agent.runnerConfig;
  const namespace = await resolveNamespace({
    organizationId: params.organizationId,
    environmentId: agent.environmentId,
  });

  const image = runnerConfig?.image ?? config.runners.defaultImage;
  await assertImageIsTrusted({
    image,
    organizationId: params.organizationId,
    environmentId: agent.environmentId,
  });

  // `deploymentName` is deliberately unset here: the frozen workload name is
  // derived from the runner's own id, which only exists after the insert.
  const runner = await RunnerModel.create({
    organizationId: params.organizationId,
    agentId: agent.id,
    createdByUserId: params.userId,
    name: params.name,
    task: params.task ?? null,
    image,
    command: runnerConfig?.command ?? null,
    steerMode: runnerConfig?.steerMode ?? "pipe",
    privileged: runnerConfig?.privileged ?? false,
    resources: runnerConfig?.resources ?? null,
    environmentId: agent.environmentId,
    namespace,
    ttlHours: runnerConfig?.ttlHours ?? config.runners.defaultTtlHours,
    idleTimeoutMinutes:
      runnerConfig?.idleTimeoutMinutes ??
      config.runners.defaultIdleTimeoutMinutes,
  });

  try {
    const { spec, virtualApiKeyId } = await buildRunnerLaunchSpec({
      runner,
      agent,
      namespace,
    });
    await RunnerModel.update(runner.id, params.organizationId, {
      virtualApiKeyId,
    });
    await runnerRuntimeManager.launch({ runner, spec });
  } catch (error) {
    // The row exists but nothing was scheduled. Record why, so the failure is
    // visible in the session timeline and not only in this response.
    const reason =
      error instanceof Error ? error.message : "Failed to start the runner";
    // `failed` is terminal, so the reconciler never revisits this row. Tear
    // down here or the Secret holding the caller's personal credentials, the
    // network policy and any created workload are stranded for good.
    const current = await RunnerModel.findById(
      runner.id,
      params.organizationId,
    );
    await runnerRuntimeManager
      .teardown(current ?? runner)
      .catch((teardownError) => {
        logger.warn(
          { error: teardownError, runnerId: runner.id },
          "Teardown after a failed runner launch did not complete",
        );
      });
    await RunnerModel.transition({
      id: runner.id,
      organizationId: params.organizationId,
      to: "failed",
      statusReason: reason,
    });
    await RunnerEventModel.append({
      runnerId: runner.id,
      kind: "state_changed",
      message: reason,
      payload: { state: "failed" },
    });
    throw error;
  }

  return (
    (await RunnerModel.findById(runner.id, params.organizationId)) ?? runner
  );
}

/**
 * A runner image runs arbitrary code holding the caller's credentials, so it
 * is held to the same trusted-registry rule as an MCP server image. An
 * environment with no configured registries places no restriction; one with a
 * list admits only those, and the check fails closed for anything else.
 */
async function assertImageIsTrusted(params: {
  image: string;
  organizationId: string;
  environmentId: string | null;
}): Promise<void> {
  const { registries, label } = await resolveTrustedImageRegistries({
    environmentId: params.environmentId,
    organizationId: params.organizationId,
  });
  if (!registries || registries.length === 0) {
    return;
  }
  if (!imageMatchesTrustedRegistries(params.image, registries)) {
    throw new ApiError(
      400,
      `Image ${params.image} is not in the trusted registries configured for ${label}`,
    );
  }
}

/**
 * Strip privileges a caller is not entitled to grant.
 *
 * A privileged runner pod holds host devices and full capabilities, so it is
 * node-level access, not an agent setting. It is only accepted from a caller
 * who already holds runner:admin — without this, any member able to edit an
 * agent could grant themselves host root by starting a runner from it.
 */
export async function sanitizeRunnerConfigForWriter<
  T extends { privileged?: boolean } | null | undefined,
>(params: {
  runnerConfig: T;
  userId: string;
  organizationId: string;
}): Promise<T> {
  const { runnerConfig } = params;
  if (!runnerConfig || runnerConfig.privileged !== true) {
    return runnerConfig;
  }
  const mayGrant = await userHasPermission(
    params.userId,
    params.organizationId,
    "runner",
    "admin",
  );
  if (mayGrant) {
    return runnerConfig;
  }
  throw new ApiError(
    403,
    "Only a runner administrator can configure a privileged runner",
  );
}

export async function requireRunnableAgent(
  agentId: string,
  organizationId: string,
): Promise<Agent> {
  const agent = await AgentModel.findById(agentId);
  // findById is not organization-scoped, so the tenant check is explicit.
  if (!agent || agent.organizationId !== organizationId) {
    throw new ApiError(404, "Agent not found");
  }
  if (!agent.runnerConfig) {
    throw new ApiError(
      400,
      "This agent has no runner configuration, so it cannot be started as a runner",
    );
  }
  return agent;
}

/**
 * Namespace the runner's pod lands in: the environment's own when the agent is
 * bound to one, otherwise the organization's default. Never creates a
 * namespace — an unknown one is an operator's decision to make.
 */
async function resolveNamespace(params: {
  organizationId: string;
  environmentId: string | null;
}): Promise<string> {
  if (params.environmentId) {
    const environment = await EnvironmentModel.findByIdForOrganization(
      params.environmentId,
      params.organizationId,
    );
    if (environment?.namespace) {
      return environment.namespace;
    }
  }
  const organization = await OrganizationModel.getById(params.organizationId);
  return (
    organization?.defaultEnvironmentNamespace ??
    config.orchestrator.kubernetes.namespace
  );
}
