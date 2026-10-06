import {
  describeOpenAppaPolicyTarget,
  type OpenAppaPolicyTargetKind,
} from "@archestra/shared";

const POLICY_LAUNCH_PROMPTS = {
  /** Overview setup step: no policy has been saved yet. */
  setUpPolicy:
    "Set up a starting OpenAPPA policy with what is already available.",
  /** Tool coverage card: how to bring more tools under a rule. */
  improveCoverage:
    "Review my OpenAPPA tool coverage and suggest how to cover more tools.",
  /** Batteries card: included batteries not enforced, or ones that fit. */
  configureBatteries:
    "Review my OpenAPPA batteries: what is not enforced, and which ones fit my MCP servers.",
  /** Security label card: the trust levels, the audiences, and their batteries. */
  explainSecurityLabel:
    "Explain the security label my OpenAPPA policy gives an agent session.",
} as const;

const TARGET_LAUNCH_PROMPTS = {
  /** Servers and gateways row: a coverage review scoped to one target. */
  reviewCoverage: (subject: string) =>
    `Review how my OpenAPPA policy governs ${subject}.`,
} as const;

export type OpenAppaLaunchPromptKey =
  | keyof typeof POLICY_LAUNCH_PROMPTS
  | keyof typeof TARGET_LAUNCH_PROMPTS;

function isOpenAppaTargetPromptKey(
  key: string,
): key is keyof typeof TARGET_LAUNCH_PROMPTS {
  return Object.hasOwn(TARGET_LAUNCH_PROMPTS, key);
}

export function openAppaYellInvestigationPrompt(yellId: string): string {
  return `Investigate OpenAPPA yell ${yellId}.`;
}

/**
 * The prompt text a launch link's key names, or undefined when the key is
 * unknown or names a target prompt and no target is given.
 */
export function resolveOpenAppaLaunchPrompt(
  key: string,
  target?: { kind: OpenAppaPolicyTargetKind; name: string; id: string },
): string | undefined {
  if (Object.hasOwn(POLICY_LAUNCH_PROMPTS, key))
    return POLICY_LAUNCH_PROMPTS[key as keyof typeof POLICY_LAUNCH_PROMPTS];
  if (!isOpenAppaTargetPromptKey(key) || !target) return undefined;
  return `${TARGET_LAUNCH_PROMPTS[key](
    describeOpenAppaPolicyTarget(target.kind, target.name),
  )}\n\nTarget type: ${target.kind}\nTarget ID: ${target.id}`;
}
