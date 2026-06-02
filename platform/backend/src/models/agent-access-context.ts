import type { AgentAccessContext } from "@/types";
import AgentModel from "./agent";

export async function findAgentAccessContextById(
  agentId: string,
): Promise<AgentAccessContext | null> {
  return AgentModel.findAccessContextById(agentId);
}
