import {
  type AgentRuntimeTierDefinitionInput,
  type AgentRuntimeTierSettingsInput,
  agentRuntimeTierDefinitionFromInput,
  agentRuntimeTierProblems,
  findAgentRuntimeTier,
  type ResolvedAgentRuntimeTiers,
  resolveAgentRuntimeTiers,
  type StoredAgentRuntimeTierSettings,
  sameAgentRuntimeTierName,
} from "@archestra/shared";
import type { Transaction } from "@/database";
import AgentModel from "@/models/agent";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import { ApiError } from "@/types";
import {
  agentRuntimeTierDefaults,
  organizationAgentRuntimeTiers,
} from "./runtime-tiers";

/**
 * Check a new tier list against the organization's agents and templates, and
 * prepare what the save writes besides the setting itself: a renamed tier is
 * followed by every agent and template that names it, and a removed tier is
 * refused while one still does. A reset (`input` null) restores the default
 * list under the same check, so a custom tier still in use cannot vanish
 * from under its agents. The caller runs `write` in the transaction that
 * stores `settings`.
 */
export async function prepareAgentRuntimeTierChange(params: {
  organizationId: string;
  input: AgentRuntimeTierSettingsInput | null;
}): Promise<{
  /** What the organization stores: null for a reset to the defaults. */
  settings: StoredAgentRuntimeTierSettings | null;
  write: (tx: Transaction) => Promise<void>;
}> {
  const { organizationId, input } = params;
  const next = input ?? defaultTierInput();
  const current = await organizationAgentRuntimeTiers(organizationId);
  const settings = {
    tiers: next.tiers
      .map((tier) => withCurrentWorkspace(tier, current))
      .map(agentRuntimeTierDefinitionFromInput),
    defaultTier: next.defaultTier,
  };
  const problems = agentRuntimeTierProblems(settings);
  if (problems.length) throw new ApiError(400, problems.join("; "));

  // One mapping from old names to new ones. The models apply it to each
  // stored name once, so renaming S to M and M to Medium in one save leaves
  // the former S agents on M.
  const renames = next.tiers.flatMap((tier) => {
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
    settings: input === null ? null : settings,
    write: async (tx) => {
      await AgentModel.renameRuntimeTiers({ organizationId, renames, tx });
      await AgentRuntimeTemplateModel.renameRuntimeTiers({
        organizationId,
        renames,
        tx,
      });
    },
  };
}

// === Internal helpers ===

/**
 * A tier saved without a workspace size keeps the size it has: a client that
 * does not know the field must not erase it. The tier is matched by its name
 * before the save, so a rename keeps the size too. Null is a choice: the
 * deployment's default.
 */
function withCurrentWorkspace(
  tier: AgentRuntimeTierDefinitionInput,
  current: ResolvedAgentRuntimeTiers,
): AgentRuntimeTierDefinitionInput {
  if (tier.workspaceGiB !== undefined) return tier;
  const before = findAgentRuntimeTier(
    current.tiers,
    tier.previousName ?? tier.name,
  );
  return { ...tier, workspaceGiB: before?.workspaceGiB ?? null };
}

/** The default list as a save would send it: what a reset restores. */
function defaultTierInput(): AgentRuntimeTierSettingsInput {
  const defaults = resolveAgentRuntimeTiers(null, agentRuntimeTierDefaults());
  return {
    tiers: defaults.tiers.map(
      ({ name, cpuRequest, cpuLimit, pooled, workspaceGiB }) => ({
        name,
        cpuRequest,
        cpuLimit,
        pooled,
        workspaceGiB,
      }),
    ),
    defaultTier: defaults.defaultTier,
  };
}
