import { assignAgentToolsFromLabels } from "@/services/agent-tool-assignment";

export async function handleAssignAgentToolsFromLabelsForAgent(
  payload: Record<string, unknown>,
): Promise<void> {
  const agentId = payload.agentId as string;

  if (!agentId) {
    throw new Error(
      "Missing agentId in assign_agent_tools_from_labels_for_agent payload",
    );
  }

  await assignAgentToolsFromLabels(agentId);
}
