import {
  describeOpenAppaPolicyTarget,
  OPENAPPA_CONFIG_SUGGESTED_PROMPTS,
  type OpenAppaPolicyTargetKind,
} from "@archestra/shared";

/**
 * The configuration agent's own suggested prompts, keyed for launch links,
 * so the overview chat strip offers the same ones the chat shows.
 */
export const OPENAPPA_SUGGESTED_LAUNCH_PROMPTS = {
  explainPolicy: OPENAPPA_CONFIG_SUGGESTED_PROMPTS[0],
  reviewRisks: OPENAPPA_CONFIG_SUGGESTED_PROMPTS[1],
  changePolicy: OPENAPPA_CONFIG_SUGGESTED_PROMPTS[2],
  validateAssumptions: OPENAPPA_CONFIG_SUGGESTED_PROMPTS[3],
} as const;

const POLICY_LAUNCH_PROMPTS = {
  writeValidations:
    "Help me choose a useful validation for my current OpenAPPA policy. Briefly explain the concrete behavior it would check and any replay limits. If no checks exist, suggest one useful starting check; otherwise, summarize their coverage and help me choose whether to review, edit or add one. Ask me which check or change to start with, then wait for my answer before drafting. After I choose, draft and replay it for review. Save only when I ask, and leave the policy unchanged unless I request a fix.",
  /** Overview setup step: no policy has been saved yet. */
  setUpPolicy:
    "Set up a starting OpenAPPA policy with what is already available.",
  /** Tool coverage card: how to bring more tools under a rule. */
  improveCoverage:
    "Review my OpenAPPA tool coverage and suggest how to cover more tools.",
  /** Batteries card: included batteries not enforced, or ones that fit. */
  configureBatteries:
    "Review my OpenAPPA batteries: what is not enforced, and which ones fit my MCP servers.",
  // Overview chat strip: the agent's suggested prompts.
  explainPolicy: OPENAPPA_SUGGESTED_LAUNCH_PROMPTS.explainPolicy.prompt,
  reviewRisks: OPENAPPA_SUGGESTED_LAUNCH_PROMPTS.reviewRisks.prompt,
  changePolicy: OPENAPPA_SUGGESTED_LAUNCH_PROMPTS.changePolicy.prompt,
  validateAssumptions:
    OPENAPPA_SUGGESTED_LAUNCH_PROMPTS.validateAssumptions.prompt,
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
