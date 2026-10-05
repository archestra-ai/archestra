import {
  describeOpenAppaPolicyTarget,
  type OpenAppaPolicyTargetKind,
} from "@archestra/shared";

const POLICY_LAUNCH_PROMPTS = {
  /** Overview setup step: no policy has been saved yet. */
  setUpPolicy:
    "Create a useful starting OpenAPPA policy with what is already available. Keep ordinary work working; leave additional batteries and detailed tuning for later. Explain which rules you recommend, with examples of what they allow or block and what remains unrestricted. Offer to show me the exact TOML, then ask for my approval to save the policy and turn it on. After saving, guide me through GitHub sync: list my available credentials, choose a connected organization GitHub App if one exists, or open the native credential setup dialog if none exists. Ask for the GitHub owner and repository name before creating the private repository from the template. Explain that later policy edits will open pull requests.",
  /** Tool coverage card: how to bring more tools under a rule. */
  improveCoverage:
    "Help me improve my OpenAPPA tool coverage. Open with a one-line summary of how many of my MCP server tools a rule covers, how many have a rule that is not enforced, and how many are not covered (a noop catch-all or no matching rule). Also review tools covered by a non-noop catch-all and suggest specific rules where tighter control is useful. Then name the biggest gaps: the servers with the most uncovered tools, and the riskiest of those tools: ones that send data out, change or delete data, or read private data. End with up to three numbered changes ranked by how many tools they would cover, such as fixing a broken battery, including a battery that fits, or adding rules, so I can reply with a number. Don't change anything until I pick one, then tell me what it would do and ask me whether to apply it.",
  /** Batteries card: included batteries not enforced, or ones that fit. */
  configureBatteries:
    "Help me configure my OpenAPPA batteries. First, for each included battery that is not enforced, tell me what is wrong and how to fix it. Then list the batteries that fit my MCP servers and are not included yet: the servers each fits, how many of their uncovered tools it would cover, and which of those tools its rules would let run, block, or send for approval. Ask me which ones to fix or include, then tell me what the change would do and ask me whether to apply it.",
  /** Policy tab header, next to the policy text. */
  explainPolicy:
    "Walk me through my current OpenAPPA policy in plain language: what it allows, denies, and sends for approval. Then ask me what I'd like to change.",
} as const;

const TARGET_LAUNCH_PROMPTS = {
  /**
   * Servers and gateways row: one review for any target, whatever its
   * coverage and whether a battery fits it: what judges its tools, the
   * riskiest ones, and a few numbered changes to pick from.
   */
  reviewCoverage: (subject: string) =>
    `Review how my OpenAPPA policy governs ${subject}. Open with a one-line summary of how many of its tools a rule covers. Group its tools by what judges them (custom rule, battery rule, catch-all rule, or not covered) and whether their calls run freely, get blocked, or need approval, naming only the riskiest few in each: tools that send data out, change or delete data, or read private data. Flag any rule that is not enforced. End with up to three numbered changes ranked by impact, such as including a battery that fits or adding rules, so I can reply with a number. Don't change anything until I pick one, then tell me what it would do and ask me whether to apply it.`,
} as const;

export type OpenAppaLaunchPromptKey =
  | keyof typeof POLICY_LAUNCH_PROMPTS
  | keyof typeof TARGET_LAUNCH_PROMPTS;

function isOpenAppaTargetPromptKey(
  key: string,
): key is keyof typeof TARGET_LAUNCH_PROMPTS {
  return Object.hasOwn(TARGET_LAUNCH_PROMPTS, key);
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
