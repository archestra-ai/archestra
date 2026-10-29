import config from "@/config";
import logger from "@/logging";
import {
  A2ATaskModel,
  AgentModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { ClusterLeaseHeldError } from "@/models/mcp-deployment-lease";
import type { AgentRuntimeTier } from "@/types";
import { ApiError } from "@/types";
import { isTerminalA2ATaskState } from "@/types/a2a-task";
import { trackBackgroundWork } from "@/utils/background-work";
import { resolveAgentRuntimeBackendDriver } from "./backends";
import { resolveAgentRuntime } from "./pod-run";
import { verifyRuntimeBinding } from "./runtime-identity";
import {
  resolveAgentRuntimeTierSettings,
  tierSwitchResumePrompt,
} from "./runtime-tier";

/**
 * Handle a run's request to move its own workspace to another tier.
 *
 * The caller is the run inside the workspace, holding no session. Its
 * server-signed runtime binding names the workspace and the turn; the turn
 * must still be the workspace's current, unfinished one. The move itself
 * replaces the Pod the caller runs in, so it continues in the background
 * after this returns: the response tells the caller to expect that.
 */
export async function requestAgentRuntimeTierSwitch(params: {
  bindingToken: string | undefined;
  tier: AgentRuntimeTier;
}): Promise<{ tier: AgentRuntimeTier; switching: boolean }> {
  const claims = params.bindingToken
    ? verifyRuntimeBinding({
        token: params.bindingToken,
        secret: config.openappa.offerSigningSecret,
      })
    : null;
  if (!claims) throw new ApiError(401, "A valid runtime binding is required");
  const [session, workspace, task] = await Promise.all([
    AgentRunModel.findByTaskId(claims.taskId),
    AgentWorkspaceModel.findById(claims.workspaceId),
    A2ATaskModel.findById(claims.taskId),
  ]);
  if (
    !session ||
    !workspace ||
    session.organizationId !== claims.organizationId ||
    workspace.organizationId !== claims.organizationId ||
    workspace.workloadName !== claims.workloadName ||
    session.workloadName !== claims.workloadName ||
    session.agentId !== claims.agentId
  )
    throw new ApiError(401, "A valid runtime binding is required");
  if (
    session.endedAt ||
    workspace.state !== "active" ||
    workspace.activeTaskId !== session.taskId ||
    !task ||
    isTerminalA2ATaskState(task.state)
  )
    throw new ApiError(409, "Only a running turn can change its runtime tier");

  const agent = await AgentModel.findById(session.agentId);
  const runtime =
    agent && agent.organizationId === session.organizationId
      ? resolveAgentRuntime(agent)
      : null;
  if (!runtime?.fullTier)
    throw new ApiError(
      409,
      "This Agent defines no Full tier, so its workspace has one runtime tier",
    );
  const settings = resolveAgentRuntimeTierSettings(runtime, params.tier);
  if (!settings)
    throw new ApiError(409, "This Agent defines no settings for that tier");
  if (settings.privileged && !config.agentRuntime.allowPrivileged)
    throw new ApiError(
      403,
      "Privileged background deployments are disabled by the deployment operator",
    );

  const backend = resolveAgentRuntimeBackendDriver(session.backend);
  if (!backend.switchWorkspaceTier)
    throw new ApiError(409, "This runtime backend has a single tier");

  // The switch replaces the Pod the caller runs in, so it continues in the
  // background. Answer once it holds the run's switch lease and knows whether
  // the workspace moves: a concurrent request is refused, never told a tier
  // the workspace is about to leave.
  const switching = await new Promise<boolean>((resolve, reject) => {
    const work = backend.switchWorkspaceTier?.({
      session,
      tier: params.tier,
      settings,
      resumePrompt: tierSwitchResumePrompt(params.tier),
      shouldResume: async () => {
        const current = await A2ATaskModel.findById(session.taskId);
        return Boolean(current && !isTerminalA2ATaskState(current.state));
      },
      onStarted: resolve,
    });
    if (!work) return;
    trackBackgroundWork(
      work.catch((error) => {
        if (error instanceof ClusterLeaseHeldError) {
          reject(
            new ApiError(409, "A runtime tier switch is already in progress"),
          );
          return;
        }
        // Before the switch started, the caller hears why; after it, the
        // replaced turn learns the outcome from its tier in the new Pod.
        reject(error);
        logger.warn(
          { error, taskId: session.taskId, tier: params.tier },
          "Agent Runtime tier switch did not complete",
        );
      }),
    );
  });
  if (switching)
    logger.info(
      { taskId: session.taskId, tier: params.tier },
      "Agent Runtime tier switch requested by its run",
    );
  return { tier: params.tier, switching };
}
