import {
  type AgentRuntimeTierSettingsInput,
  agentRuntimeTierProblems,
  findAgentRuntimeTier,
  sameAgentRuntimeTierName,
} from "@archestra/shared";
import type { Transaction } from "@/database";
import AgentModel from "@/models/agent";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import { ApiError } from "@/types";
import { organizationAgentRuntimeTiers } from "./runtime-tiers";

/**
 * Check a new tier list against the organization's agents and templates, and
 * prepare what the save writes besides the setting itself: a renamed tier is
 * followed by every agent and template that names it, and a removed tier is
 * refused while one still does. The caller runs `write` in the transaction
 * that stores `settings`.
 */
export async function prepareAgentRuntimeTierChange(params: {
  organizationId: string;
  input: AgentRuntimeTierSettingsInput;
}): Promise<{
  settings: AgentRuntimeTierSettingsInput;
  write: (tx: Transaction) => Promise<void>;
}> {
  const { organizationId, input } = params;
  const settings: AgentRuntimeTierSettingsInput = {
    tiers: input.tiers.map(({ previousName: _previousName, ...tier }) => tier),
    defaultTier: input.defaultTier,
  };
  const problems = agentRuntimeTierProblems(settings);
  if (problems.length) throw new ApiError(400, problems.join("; "));

  const current = await organizationAgentRuntimeTiers(organizationId);
  const renames = input.tiers.flatMap((tier) => {
    const previous = findAgentRuntimeTier(current.tiers, tier.previousName);
    return previous && !sameAgentRuntimeTierName(previous.name, tier.name)
      ? [{ from: previous.name, to: tier.name }]
      : [];
  });
  const renamedAway = new Set(
    renames.map((rename) => rename.from.toLowerCase()),
  );
  const removed = current.tiers.filter(
    (tier) =>
      !renamedAway.has(tier.name.toLowerCase()) &&
      !findAgentRuntimeTier(settings.tiers, tier.name),
  );
  for (const tier of removed) {
    const agents = await AgentModel.countRuntimeTierReferences({
      organizationId,
      name: tier.name,
    });
    const templates =
      await AgentRuntimeTemplateModel.countRuntimeTierReferences({
        organizationId,
        name: tier.name,
      });
    if (agents + templates > 0) {
      const users = [
        agents > 0 ? `${agents} agent${agents === 1 ? "" : "s"}` : null,
        templates > 0
          ? `${templates} template${templates === 1 ? "" : "s"}`
          : null,
      ]
        .filter(Boolean)
        .join(" and ");
      throw new ApiError(
        400,
        `Tier ${tier.name} is the default or scaleup tier of ${users}; move them to another tier first`,
      );
    }
  }
  return {
    settings,
    write: async (tx) => {
      for (const rename of renames) {
        await AgentModel.renameRuntimeTier({ organizationId, ...rename, tx });
        await AgentRuntimeTemplateModel.renameRuntimeTier({
          organizationId,
          ...rename,
          tx,
        });
      }
    },
  };
}
