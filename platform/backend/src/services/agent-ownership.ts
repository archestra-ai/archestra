import {
  getAgentTypePermissionChecker,
  requireScopedModifyPermission,
} from "@/auth/agent-type-permissions";
import { isServiceAccountUserId } from "@/auth/utils";
import {
  AgentModel,
  LlmProviderApiKeyModel,
  MemberModel,
  TeamModel,
} from "@/models";
import { ApiError } from "@/types";
import { assertNoStaticPinsBrokenByTargetChange } from "./agent-tool-assignment";

export async function transferAgentOwnership(params: {
  agentId: string;
  ownerId: string;
  userId: string;
  organizationId: string;
}): Promise<void> {
  const { agentId, ownerId, userId, organizationId } = params;
  const agent = await AgentModel.findById(agentId, userId, true);
  if (!agent || agent.organizationId !== organizationId) {
    throw new ApiError(404, "Agent not found");
  }
  const checker = await getAgentTypePermissionChecker({
    userId,
    organizationId,
  });
  checker.require(agent.agentType, "update");
  if (agent.authorId !== userId && !checker.isAdmin(agent.agentType)) {
    throw new ApiError(
      403,
      "Only the owner or a resource admin can transfer ownership",
    );
  }
  if (
    agent.builtIn ||
    agent.isPersonalGateway ||
    agent.isPersonalProxy ||
    agent.agentType === "llm_proxy"
  ) {
    throw new ApiError(400, "Platform-managed resources cannot be transferred");
  }
  if (ownerId === agent.authorId) {
    throw new ApiError(400, "Choose a different owner");
  }
  if (
    isServiceAccountUserId(ownerId) ||
    !(await MemberModel.getByUserId(ownerId, organizationId))
  ) {
    throw new ApiError(
      400,
      "The new owner must be a user in this organization",
    );
  }
  const recipient = await getAgentTypePermissionChecker({
    userId: ownerId,
    organizationId,
  });
  const recipientTeamIds = await TeamModel.getUserTeamIds(ownerId);
  try {
    recipient.require(agent.agentType, "read");
    recipient.require(agent.agentType, "update");
    requireScopedModifyPermission({
      isAdmin: recipient.isAdmin(agent.agentType),
      isTeamAdmin: recipient.isTeamAdmin(agent.agentType),
      scope: agent.scope,
      authorId: ownerId,
      resourceTeamIds: agent.teams.map((team) => team.id),
      userTeamIds: recipientTeamIds,
      userId: ownerId,
      resourceLabel: "resource",
    });
  } catch {
    throw new ApiError(
      400,
      "The new owner needs permission to manage the resource at its current visibility",
    );
  }
  const target = {
    organizationId,
    scope: agent.scope,
    authorId: agent.authorId,
    teamIds: agent.teams.map((team) => team.id),
  };
  await assertNoStaticPinsBrokenByTargetChange({
    agentId,
    currentTarget: target,
    nextTarget: { ...target, authorId: ownerId },
  });
  if (agent.llmApiKeyId) {
    const keys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      organizationId,
      ownerId,
      recipientTeamIds,
    );
    if (!keys.some((key) => key.id === agent.llmApiKeyId)) {
      throw new ApiError(
        400,
        "The new owner must have access to the agent's model API key. Change the model credentials before transferring ownership.",
      );
    }
  }
  const transferred = await AgentModel.transferOwnership({
    id: agentId,
    organizationId,
    previousOwnerId: agent.authorId,
    updatedAt: agent.updatedAt,
    ownerId,
  });
  if (!transferred) {
    throw new ApiError(409, "The resource changed. Refresh and try again.");
  }
}
