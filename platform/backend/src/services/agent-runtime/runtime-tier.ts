import { followAgentCatalogImage } from "@archestra/shared";
import config from "@/config";
import type { AgentRuntime, AgentRuntimeTier } from "@/types";
import type { AgentRuntimeTierSettings } from "./backends";
import { AGENT_RUNTIME_TIER_ENV } from "./runtime-contract";

/**
 * Compute settings for one tier of an Agent's runtime. The Lite tier is the
 * primary settings; the Full tier is `fullTier`, whose omitted fields keep
 * the primary value. Null when the Agent defines no Full tier.
 */
export function resolveAgentRuntimeTierSettings(
  runtime: TierSource,
  tier: "light",
): AgentRuntimeTierSettings;
export function resolveAgentRuntimeTierSettings(
  runtime: TierSource,
  tier: AgentRuntimeTier,
): AgentRuntimeTierSettings | null;
export function resolveAgentRuntimeTierSettings(
  runtime: TierSource,
  tier: AgentRuntimeTier,
): AgentRuntimeTierSettings | null {
  const withDefaults = (resources: AgentRuntime["resources"]) =>
    resources ?? {
      cpuRequest: config.agentRuntime.resources.cpuRequest,
      memoryRequest: config.agentRuntime.resources.memoryRequest,
      memoryLimit: config.agentRuntime.resources.memoryLimit,
    };
  if (tier === "light")
    return {
      image: runtime.image,
      privileged: runtime.privileged,
      resources: withDefaults(runtime.resources),
    };
  const full = runtime.fullTier;
  if (!full) return null;
  return {
    image: followAgentCatalogImage({
      image: full.image,
      catalogImages: config.agentRuntime.catalogImages,
    }),
    privileged: full.privileged ?? runtime.privileged,
    resources: withDefaults(
      full.resources === undefined ? runtime.resources : full.resources,
    ),
  };
}

/**
 * What the continued turn is told after its Pod was replaced. Written before
 * the switch, so it names the requested tier and points at the Pod's own
 * value: a tier that cannot start leaves the workspace on the previous one.
 */
export function tierSwitchResumePrompt(tier: AgentRuntimeTier): string {
  const name = tier === "full" ? "Full" : "Lite";
  return [
    `[Archestra] The platform restarted this workspace to move it to its ${name} tier, as you requested.`,
    `${AGENT_RUNTIME_TIER_ENV} names the tier it runs on now; when it is not ${tier}, that tier could not start and the workspace stayed where it was.`,
    "Your files, the repository checkout and this conversation were kept. Processes that were running were stopped, including the command that asked for the switch; development services the tier provides start again on their own.",
    "Continue the task from where you left off.",
  ].join(" ");
}

type TierSource = Pick<
  AgentRuntime,
  "image" | "privileged" | "resources" | "fullTier"
>;
