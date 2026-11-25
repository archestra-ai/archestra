import { getResourceForAgentType } from "@archestra/shared";
import { AgentModel, LlmProviderApiKeyModel, TeamModel } from "@/models";
import { ApiError } from "@/types";
import { assertNoStaticPinsBrokenByTargetChange } from "./mcp-server-assignability";
import { ResourcePermissions } from "./resource-permissions";

export async function transferAgentOwnership(params: {
  agentId: string;
  ownerId: string;
  userId: string;
  organizationId: string;
}): Promise<void> {
  const { agentId, ownerId, userId, organizationId } = params;
  const { agent, resource } = await loadTransferableAgent({
    agentId,
    organizationId,
    userId,
  });
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  await ResourcePermissions.authorizeOwnershipTransfer({
    organizationId,
    userId,
    resource,
    scope: agentId,
    ownerId,
  });
  // SPDX-SnippetEnd
  await reassignAgent({ agent, resource, ownerId, organizationId });
}

/**
 * Give an agent or gateway to a new owner without checking who asked: the
 * caller already decided the handoff (a member leaving the organization).
 * Every other transfer rule still applies.
 */
export async function handOffAgentOwnership(params: {
  agentId: string;
  ownerId: string;
  organizationId: string;
}): Promise<void> {
  const { agent, resource } = await loadTransferableAgent({
    agentId: params.agentId,
    organizationId: params.organizationId,
    userId: params.ownerId,
  });
  await reassignAgent({ ...params, agent, resource });
}

// ===================================================================
// Internal helpers
// ===================================================================

async function loadTransferableAgent(params: {
  agentId: string;
  organizationId: string;
  userId: string;
}) {
  const agent = await AgentModel.findById(params.agentId, params.userId, true);
  if (!agent || agent.organizationId !== params.organizationId) {
    throw new ApiError(404, "Agent not found");
  }
  if (
    agent.builtIn ||
    agent.isPersonalGateway ||
    agent.isPersonalProxy ||
    agent.agentType === "llm_proxy"
  ) {
    throw new ApiError(400, "Platform-managed resources cannot be transferred");
  }
  const resource = getResourceForAgentType(agent.agentType);
  if (resource !== "agent" && resource !== "mcpGateway") {
    throw new ApiError(400, "Platform-managed resources cannot be transferred");
  }
  return { agent, resource };
}

async function reassignAgent(params: {
  agent: NonNullable<Awaited<ReturnType<typeof AgentModel.findById>>>;
  resource: "agent" | "mcpGateway";
  ownerId: string;
  organizationId: string;
}): Promise<void> {
  const { agent, resource, ownerId, organizationId } = params;
  const agentId = agent.id;
  if (ownerId === agent.authorId) {
    throw new ApiError(400, "Choose a different owner");
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
      await TeamModel.getUserTeamIds(ownerId),
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
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  await ResourcePermissions.transferOwnerGrant({
    organizationId,
    resource,
    scope: agentId,
    previousOwnerId: agent.authorId,
    ownerId,
  });
  // SPDX-SnippetEnd
}
