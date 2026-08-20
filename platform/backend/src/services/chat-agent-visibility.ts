import { getAgentTypePermissionChecker } from "@/auth/agent-type-permissions";
import { AgentModel } from "@/models";
import type { Agent } from "@/types";

/**
 * Resolves "is this a chat agent the caller can see?" — the same question the
 * /chat picker answers when it lists agents, so what a member can start a chat
 * with is exactly what they can pin as their default.
 *
 * "Can see" is `findById`'s access check, with the agent-admin bypass the list
 * route applies for the `agent` type: an admin's picker offers every agent in
 * the organization, including other members' personal ones, and the two
 * surfaces must not disagree about which of those they may pin.
 *
 * Null covers every miss the same way — no such agent, one from another
 * organization, one this caller cannot reach, a built-in, or a gateway/proxy
 * that is not a chat agent. Callers turn that into one undifferentiated 404,
 * so nothing leaks about agents the caller cannot see.
 */
/**
 * One permission lookup, reusable across several ids — the default-agent chain
 * asks about the member's pin and then the organization's, and both must be
 * judged by the same rule as the pin that created them.
 */
export async function chatAgentVisibilityFor(params: {
  userId: string;
  organizationId: string;
}): Promise<{ find(agentId: string): Promise<Agent | null> }> {
  const { userId, organizationId } = params;
  const checker = await getAgentTypePermissionChecker({
    userId,
    organizationId,
  });
  const isAgentAdmin = checker.isAdmin("agent");

  return {
    async find(agentId: string): Promise<Agent | null> {
      const agent = await AgentModel.findById(agentId, userId, isAgentAdmin);
      if (
        !agent ||
        agent.organizationId !== organizationId ||
        agent.agentType !== "agent" ||
        agent.builtIn
      ) {
        return null;
      }
      return agent;
    },
  };
}

/** Single-id convenience for callers judging exactly one agent. */
export async function findVisibleChatAgent(params: {
  agentId: string;
  userId: string;
  organizationId: string;
}): Promise<Agent | null> {
  const visibility = await chatAgentVisibilityFor(params);
  return visibility.find(params.agentId);
}
