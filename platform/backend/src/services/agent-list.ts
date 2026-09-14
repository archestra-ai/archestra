import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import type { Agent } from "@/types";
import { listPolicyIndependentAvailableAgentSkills } from "./agent-activation-skill-candidates";
import { agentActivationSkillPolicyService } from "./agent-activation-skill-policy";
import {
  getAgentSkillActivationAvailability,
  projectEffectiveAvailableAgentSkills,
} from "./agent-activation-skills";

/**
 * Add the caller-relative activation count used by internal-agent cards.
 * Tool reachability is agent-specific; catalog resolution is shared per
 * represented environment after disabled agents have been removed.
 */
export async function populateAgentListActivationSkillCounts(params: {
  agents: Agent[];
  organizationId: string;
  userId: string;
}): Promise<void> {
  const internalAgents = params.agents.filter(
    (agent) => agent.agentType === "agent",
  );
  if (internalAgents.length === 0) return;

  const skillChecker = await getSkillPermissionChecker({
    userId: params.userId,
    organizationId: params.organizationId,
  });
  if (!skillChecker.canRead) return;

  const availabilityByAgent = await getAgentSkillActivationAvailability({
    agents: internalAgents,
    userId: params.userId,
  });
  const activeAgents = internalAgents.filter(
    (agent) => availabilityByAgent.get(agent.id) === true,
  );
  const environmentIds = [
    ...new Set(activeAgents.map((agent) => agent.environmentId ?? null)),
  ];
  const [candidateEntries, evaluators] = await Promise.all([
    Promise.all(
      environmentIds.map(
        async (environmentId) =>
          [
            environmentId ?? "default",
            await listPolicyIndependentAvailableAgentSkills({
              organizationId: params.organizationId,
              userId: params.userId,
              environmentId,
            }),
          ] as const,
      ),
    ),
    agentActivationSkillPolicyService.getEvaluators(
      activeAgents.map((agent) => agent.id),
    ),
  ]);
  const candidatesByEnvironment = new Map(candidateEntries);
  const countsByAgent = new Map(
    activeAgents.map((agent) => {
      const candidates =
        candidatesByEnvironment.get(agent.environmentId ?? "default") ?? [];
      return [
        agent.id,
        projectEffectiveAvailableAgentSkills(
          candidates,
          params.userId,
          evaluators.get(agent.id) ?? null,
        ).length,
      ] as const;
    }),
  );
  for (const agent of internalAgents) {
    agent.activationSkillsCount = countsByAgent.get(agent.id) ?? 0;
  }
}
