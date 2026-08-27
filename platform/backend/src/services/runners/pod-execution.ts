import config from "@/config";
import { runnerRuntimeManager } from "@/k8s/runner-runtime";
import { constructFrozenRunnerName } from "@/k8s/runner-runtime/naming";
import logger from "@/logging";
import {
  EnvironmentModel,
  OrganizationModel,
  RunnerModel,
  RunnerSessionModel,
} from "@/models";
import type { Runner, RunnerSession } from "@/types";
import { ApiError } from "@/types";
import { buildRunnerLaunchSpec } from "./launch-spec";

/**
 * Run one A2A task inside a pod.
 *
 * This is the `executeRun` the A2A task lifecycle already injects, swapped for
 * a Kubernetes-backed one. Everything above it — the compare-and-set state
 * machine, the response artifact, the durable event log, cancellation, push
 * notifications and SSE subscribers — is unchanged, because the lifecycle only
 * ever knew that contract.
 *
 * The pod is started and then followed: the session's stdout becomes the
 * task's streamed text, and abort tears the pod down.
 */
export async function startPodSession(params: {
  runner: Runner;
  taskId: string;
  agentId: string;
  actorUserId: string;
  organizationId: string;
  task?: string | null;
}): Promise<RunnerSession> {
  if (!runnerRuntimeManager.isEnabled) {
    throw new ApiError(
      503,
      "Runners are not available on this deployment, so this task cannot run in a container",
    );
  }

  const namespace = await resolveNamespace({
    organizationId: params.organizationId,
    environmentId: params.runner.environmentId,
  });

  const { spec, virtualApiKeyId } = await buildRunnerLaunchSpec({
    runner: params.runner,
    taskId: params.taskId,
    agentId: params.agentId,
    actorUserId: params.actorUserId,
    organizationId: params.organizationId,
    namespace,
    task: params.task,
  });

  // The row lands before the workload: it is what teardown reads to find the
  // objects, so a crash between the two must leave a record, not an orphan.
  const session = await RunnerSessionModel.create({
    organizationId: params.organizationId,
    taskId: params.taskId,
    runnerId: params.runner.id,
    actorUserId: params.actorUserId,
    deploymentName: spec.frozenName,
    namespace,
    secretName: `${spec.frozenName}-env`,
    virtualApiKeyId,
  });

  try {
    await runnerRuntimeManager.launch(spec);
  } catch (error) {
    // Nothing was scheduled, but a Secret holding the actor's personal
    // credentials may already exist. Close the session so the reconciler does
    // not adopt it, and remove whatever landed.
    await runnerRuntimeManager.teardown(session).catch((teardownError) => {
      logger.warn(
        { error: teardownError, sessionId: session.id },
        "Teardown after a failed runner launch did not complete",
      );
    });
    await RunnerSessionModel.close(session.id);
    throw error;
  }

  return session;
}

/** The runner an agent's long-running work executes on, if it has one. */
export async function resolveRunnerForAgent(params: {
  runnerId: string | null;
  organizationId: string;
}): Promise<Runner | null> {
  if (!params.runnerId) return null;
  return RunnerModel.findById(params.runnerId, params.organizationId);
}

/** Frozen workload name for a task, used when adopting an existing pod. */
export function sessionDeploymentName(runner: Runner, taskId: string): string {
  return constructFrozenRunnerName(runner.name, taskId);
}

/**
 * Namespace a session's pod lands in: the runner's environment when it has
 * one, otherwise the organization's default. Never creates a namespace — an
 * unknown one is an operator's decision to make.
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
