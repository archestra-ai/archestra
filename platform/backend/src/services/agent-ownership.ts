import { getResourceForAgentType } from "@archestra/shared";
import { AgentModel, LlmProviderApiKeyModel, TeamModel } from "@/models";
import { ApiError } from "@/types";
import { assertNoStaticPinsBrokenByTargetChange } from "./agent-tool-assignment";
import { ResourcePermissions } from "./resource-permissions";

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
