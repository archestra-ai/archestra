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
  explainGuardrails: OPENAPPA_CONFIG_SUGGESTED_PROMPTS[0],
  explainPolicy: OPENAPPA_CONFIG_SUGGESTED_PROMPTS[1],
  reviewRisks: OPENAPPA_CONFIG_SUGGESTED_PROMPTS[2],
  changePolicy: OPENAPPA_CONFIG_SUGGESTED_PROMPTS[3],
  validatePolicy: OPENAPPA_CONFIG_SUGGESTED_PROMPTS[4],
} as const;

const POLICY_LAUNCH_PROMPTS = {
  /** Validations page: same request as the overview's validate prompt. */
  writeValidations: OPENAPPA_SUGGESTED_LAUNCH_PROMPTS.validatePolicy.prompt,
  /** Validations page: explain what the saved checks protect. */
  explainValidations: "Explain my OpenAPPA validations.",
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
  explainGuardrails: OPENAPPA_SUGGESTED_LAUNCH_PROMPTS.explainGuardrails.prompt,
  explainPolicy: OPENAPPA_SUGGESTED_LAUNCH_PROMPTS.explainPolicy.prompt,
  reviewRisks: OPENAPPA_SUGGESTED_LAUNCH_PROMPTS.reviewRisks.prompt,
  changePolicy: OPENAPPA_SUGGESTED_LAUNCH_PROMPTS.changePolicy.prompt,
  validatePolicy: OPENAPPA_SUGGESTED_LAUNCH_PROMPTS.validatePolicy.prompt,
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
 * unknown or names a target prompt and no target is given. A policy prompt
 * given a target (and optionally one of its tools) is narrowed to it.
 */
export function resolveOpenAppaLaunchPrompt(
  key: string,
  target?: OpenAppaLaunchTarget,
): string | undefined {
  if (Object.hasOwn(POLICY_LAUNCH_PROMPTS, key)) {
    const prompt =
      POLICY_LAUNCH_PROMPTS[key as keyof typeof POLICY_LAUNCH_PROMPTS];
    if (!target) return prompt;
    const subject = describeOpenAppaPolicyTarget(target.kind, target.name);
    const focus = target.tool
      ? `Focus on the tool "${target.tool}" of ${subject}.`
      : `Focus on ${subject}.`;
    return `${prompt} ${focus}${targetLines(target)}`;
  }
  if (!isOpenAppaTargetPromptKey(key) || !target) return undefined;
  return `${TARGET_LAUNCH_PROMPTS[key](
    describeOpenAppaPolicyTarget(target.kind, target.name),
  )}${targetLines(target)}`;
}

export type OpenAppaLaunchTarget = {
  kind: OpenAppaPolicyTargetKind;
  name: string;
  id: string;
  /** One of the target's tools, by name. */
  tool?: string;
};

function targetLines(target: OpenAppaLaunchTarget): string {
  return `\n\nTarget type: ${target.kind}\nTarget ID: ${target.id}${
    target.tool ? `\nTool: ${target.tool}` : ""
  }`;
}
