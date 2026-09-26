import {
  describeOpenAppaPolicyTarget,
  OPENAPPA_CONFIG_SUGGESTED_PROMPTS,
  type OpenAppaPolicyTargetKind,
} from "@archestra/shared";

/**
 * Every prompt the OpenAPPA policy chat is started or steered with. Add new
 * ones here, not at the call site, so what the agent is asked and from where
 * reads in one place. Launch with `openAppaChatHref({ promptKey })`: the link
 * carries the key, not the text, and the chat resolves it with
 * `resolveOpenAppaLaunchPrompt`, so a prompt can grow without growing the URL.
 *
 * A launch prompt is sent as the user's first message and titles the chat, so
 * it speaks as the user. Any prompt that can lead to a policy change asks the
 * agent to explain what the change would do and ask before applying it: the user decides what is
 * published.
 */
const POLICY_LAUNCH_PROMPTS = {
  /** Overview setup step: no policy has been saved yet. */
  setUpPolicy:
    "Create a useful starting OpenAPPA policy with what is already available. Keep ordinary work working; leave GitHub sync, credentials, and additional batteries for later. Explain which rules you recommend, with examples of what they allow or block and what remains unrestricted. Offer to show me the exact TOML, then ask for my approval to save the policy and turn it on.",
  /** Tool coverage card: how to bring more tools under a rule. */
  improveCoverage:
    "Help me improve my OpenAPPA tool coverage. Open with a one-line summary of how many of my MCP server tools a rule covers, how many have a rule that is not enforced, and how many only the catch-all decides. Then name the biggest gaps: the servers with the most tools no rule covers, and the riskiest of those tools: ones that send data out, change or delete data, or read private data. End with up to three numbered changes ranked by how many tools they would cover, such as fixing a broken battery, including a battery that fits, or adding rules, so I can reply with a number. Don't change anything until I pick one, then tell me what it would do and ask me whether to apply it.",
  /** Batteries card: included batteries not enforced, or ones that fit. */
  configureBatteries:
    "Help me configure my OpenAPPA batteries. First, for each included battery that is not enforced, tell me what is wrong and how to fix it. Then list the batteries that fit my MCP servers and are not included yet: the servers each fits, how many of their tools with no rule it would cover, and which of those tools its rules would let run, block, or send for approval. Ask me which ones to fix or include, then tell me what the change would do and ask me whether to apply it.",
  /** Policy tab header, next to the policy text. */
  explainPolicy:
    "Walk me through my current OpenAPPA policy in plain language: what it allows, denies, and sends for approval. Then ask me what I'd like to change.",
} as const;

/**
 * Prompts for a chat scoped to one policy target, worded around the target's
 * description. They resolve only once the chat has loaded the target.
 */
const TARGET_LAUNCH_PROMPTS = {
  /**
   * Servers and gateways row: one review for any target, whatever its
   * coverage and whether a battery fits it: what judges its tools, the
   * riskiest ones, and a few numbered changes to pick from.
   */
  reviewCoverage: (subject: string) =>
    `Review how my OpenAPPA policy governs ${subject}. Open with a one-line summary of how many of its tools a rule covers. Group its tools by what judges them (my own rule, a battery, or only the catch-all) and whether their calls run freely, get blocked, or need approval, naming only the riskiest few in each: tools that send data out, change or delete data, or read private data. Flag any rule that is not enforced. End with up to three numbered changes ranked by impact, such as including a battery that fits or adding rules, so I can reply with a number. Don't change anything until I pick one, then tell me what it would do and ask me whether to apply it.`,
} as const;

export type OpenAppaLaunchPromptKey =
  | keyof typeof POLICY_LAUNCH_PROMPTS
  | keyof typeof TARGET_LAUNCH_PROMPTS;

/** Whether the prompt `key` names needs the chat's target to resolve. */
export function isOpenAppaTargetPromptKey(
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
  target?: { kind: OpenAppaPolicyTargetKind; name: string },
): string | undefined {
  if (Object.hasOwn(POLICY_LAUNCH_PROMPTS, key))
    return POLICY_LAUNCH_PROMPTS[key as keyof typeof POLICY_LAUNCH_PROMPTS];
  if (!isOpenAppaTargetPromptKey(key) || !target) return undefined;
  return TARGET_LAUNCH_PROMPTS[key](
    describeOpenAppaPolicyTarget(target.kind, target.name),
  );
}

/**
 * The pills on the start screen of a new policy chat. The untargeted set is
 * seeded onto the OpenAPPA agent by the backend, so it lives in
 * `@archestra/shared`; the targeted set rewords it to name the target.
 */
export function openAppaSuggestedPrompts(target?: {
  kind: OpenAppaPolicyTargetKind;
  name: string;
}): { summaryTitle: string; prompt: string }[] {
  if (!target) return [...OPENAPPA_CONFIG_SUGGESTED_PROMPTS];
  const subject = describeOpenAppaPolicyTarget(target.kind, target.name);
  return [
    {
      summaryTitle: `Explain the policy for ${target.name}`,
      prompt: `Explain the current OpenAPPA policy for ${subject} in plain language. What do its rules allow, deny, or require approval for? Do not change it.`,
    },
    {
      summaryTitle: `Review risky calls for ${target.name}`,
      prompt: `Review the current OpenAPPA policy for ${subject} for risky tool calls and gaps. Suggest specific changes, but do not publish anything yet.`,
    },
    {
      summaryTitle: `Change the policy for ${target.name}`,
      prompt: `Help me change the OpenAPPA policy for ${subject}. Ask what I want to protect, inspect its current rules, and tell me what the change would do before publishing.`,
    },
  ];
}
