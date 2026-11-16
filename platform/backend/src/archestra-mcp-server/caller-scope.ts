import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import AgentModel from "@/models/agent";
import type { Agent } from "@/types";
import type { ArchestraContext } from "./types";

type CallerScope = "organization" | "agent";

/**
 * The persisted organization agent behind a tool call, or null when the call
 * names no such agent. Only the built-in OpenAPPA configuration and APPA tuner
 * agents read across environments (scope "organization"); every other agent
 * stays in its own scope.
 */
export async function resolveCallerScope(
  context: ArchestraContext,
): Promise<{ agent: Agent; scope: CallerScope } | null> {
  const agent = await AgentModel.findById(context.agent.id);
  if (
    !agent ||
    !context.organizationId ||
    agent.organizationId !== context.organizationId ||
    (context.agentId !== undefined && context.agentId !== agent.id)
  )
    return null;
  return {
    agent,
    scope:
      agent.agentType === "agent" && readsOrganizationWide(agent)
        ? "organization"
        : "agent",
  };
}

function readsOrganizationWide(agent: Agent): boolean {
  switch (agent.builtInAgentConfig?.name) {
    case BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG:
    case BUILT_IN_AGENT_IDS.APPA_TUNER:
      return true;
    default:
      return false;
  }
}
