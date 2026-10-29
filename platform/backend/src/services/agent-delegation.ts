import {
  getAgentTypePermissionChecker,
  requireAgentModifyPermission,
} from "@/auth";
import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import { withDbTransaction } from "@/database";
import { AgentModel, AgentToolModel, AgentVersionModel } from "@/models";
import { ApiError } from "@/types";

export async function createAgentDelegation(params: {
  agentId: string;
  targetAgentId: string;
  organizationId: string;
  userId: string;
}): Promise<boolean> {
  const agent = await AgentModel.findById(params.agentId, params.userId, true);
  if (!agent || agent.organizationId !== params.organizationId) {
    throw new ApiError(404, "Agent not found");
  }
  const checker = await getAgentTypePermissionChecker(params);
  try {
    checker.require(agent.agentType, { action: "update", scope: agent.id });
  } catch {
    throw new ApiError(404, "Agent not found");
  }
  requireAgentModifyPermission({
    agentId: agent.id,
    action: "update",
    checker,
    agentType: agent.agentType,
  });
  if (agent.agentType === "llm_proxy")
    throw new ApiError(400, "LLM proxies cannot have subagents");
  if (params.agentId === params.targetAgentId)
    throw new ApiError(400, "An agent cannot delegate to itself");
  const target = await AgentModel.findById(
    params.targetAgentId,
    params.userId,
    checker.isAdmin("agent"),
  );
  if (!target || target.organizationId !== params.organizationId)
    throw new ApiError(404, "Target agent not found");
  if (target.agentType !== "agent")
    throw new ApiError(400, "Delegation target must be an internal agent");

  const created = await withDbTransaction(async (tx) => {
    // Stable lock order protects shared targets and duplicate edge requests.
    const participants = await AgentModel.lockDelegationParticipants({
      ids: [agent.id, target.id],
      organizationId: params.organizationId,
      tx,
    });
    const source = participants.find((row) => row.id === agent.id);
    const destination = participants.find((row) => row.id === target.id);
    if (!source || !destination)
      throw new ApiError(404, "Delegation participant not found");
    if (source.agentType === "llm_proxy" || destination.agentType !== "agent")
      throw new ApiError(400, "Invalid delegation participant type");
    return AgentToolModel.assignDelegation({
      agentId: agent.id,
      targetAgentId: target.id,
      tx,
    });
  });
  if (created) {
    await AgentVersionModel.forkIfChangedBestEffort(agent.id);
    clearChatMcpClient(agent.id);
  }
  return created;
}
