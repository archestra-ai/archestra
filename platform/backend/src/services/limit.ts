import AgentModel from "@/models/agent";
import LimitModel from "@/models/limit";
import { ApiError } from "@/types";
import type { CreateLimit } from "@/types/limit";

export async function createLimit(data: CreateLimit) {
  if (data.entityType === "agent" && data.limitType === "token_cost") {
    const agent = await AgentModel.findById(data.entityId);
    if (agent?.agentType === "llm_proxy") {
      throw new ApiError(
        400,
        "LLM Proxy cost limits are no longer supported. Use an organization limit instead.",
      );
    }
  }
  return LimitModel.create(data);
}
