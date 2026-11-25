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
  /** New validation: same request as the overview's validate prompt. */
  writeValidations: OPENAPPA_SUGGESTED_LAUNCH_PROMPTS.validatePolicy.prompt,
  /** Explain what the saved validations protect. */
  explainValidations: "Explain my OpenAPPA validations.",
  /** Overview setup step: no policy has been saved yet. */
  setUpPolicy:
    "Set up a starting OpenAPPA policy with what is already available.",
  /** Tool coverage card: specific rules for tools with none or only the catch-all. */
  improveCoverage:
    "Review my OpenAPPA tool coverage and suggest specific rules for tools that have no rule or only the catch-all rule.",
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
  /** A server's page, for its editors: its own rules file, by pull request. */
  editServerRules: (subject: string) =>
    `Help me change the Guardrails rules of ${subject}: its own rules file in the policy repository.`,
} as const;

const BATTERY_LAUNCH_PROMPTS: {
  [Key in OpenAppaBatteryChange["promptKey"]]: (
    change: Extract<OpenAppaBatteryChange, { promptKey: Key }>,
  ) => string;
} = {
  /** An organization battery's Include switch, turned on. */
  includeBattery: ({ battery }) =>
    `Include the battery "${battery.name}" in my OpenAPPA policy: add its entry to \`include\`.`,
  /** A battery row's Remove from policy, or the Include switch turned off. */
  removeBattery: ({ battery }) =>
    `Remove the battery "${battery.name}" from my OpenAPPA policy: take its entry out of \`include\`, with the \`[aliases.mcp]\` lines that point its namespaces at MCP servers.`,
  /** The dialog's Attach to a server. */
  attachBattery: ({ battery, server }) =>
    `Attach the battery "${battery.name}" to ${describeOpenAppaPolicyTarget("mcp_server", server.name)}: point its namespaces at the server's tools in \`[aliases.mcp]\`, and add its entry to \`include\` if it is not there.`,
  /** A server's Detach in the dialog. */
  detachBattery: ({ battery, server }) =>
    `Detach the battery "${battery.name}" from ${describeOpenAppaPolicyTarget("mcp_server", server.name)}: remove the server from its namespaces in \`[aliases.mcp]\`. If no server is left, take its entry out of \`include\` too.`,
  /** A credential the policy text sets, so the dialog cannot choose it. */
  removeCredentialLine: ({ battery, variable }) =>
    `Remove the \`[credentials]\` line that sets ${variable} from my OpenAPPA policy, so the battery "${battery.name}" reads a credential chosen on the Batteries page.`,
};

export type OpenAppaLaunchPromptKey =
  | keyof typeof POLICY_LAUNCH_PROMPTS
  | keyof typeof TARGET_LAUNCH_PROMPTS;

function isOpenAppaTargetPromptKey(
  key: string,
): key is keyof typeof TARGET_LAUNCH_PROMPTS {
  return Object.hasOwn(TARGET_LAUNCH_PROMPTS, key);
}

/**
 * One battery change, as the Batteries page asks the configuration agent for
 * it while Git sync owns the policy: the agent previews it, the user approves
 * the card, and a pull request carries it.
 */
export type OpenAppaBatteryChange =
  | ({ promptKey: "includeBattery" } & BatteryChangeOf)
  | ({ promptKey: "removeBattery" } & BatteryChangeOf)
  | ({ promptKey: "attachBattery" } & ServerChangeOf)
  | ({ promptKey: "detachBattery" } & ServerChangeOf)
  | ({ promptKey: "removeCredentialLine" } & BatteryChangeOf & {
        /** The credential variable a `[credentials]` line sets. */
        variable: string;
      });

/**
 * The prompt for one battery change: the request, then the exact battery,
 * server and variable it names, so the agent edits the right lines.
 */
export function resolveOpenAppaBatteryPrompt(
  change: OpenAppaBatteryChange,
): string {
  const request = (
    BATTERY_LAUNCH_PROMPTS[change.promptKey] as (
      change: OpenAppaBatteryChange,
    ) => string
  )(change);
  const { battery } = change;
  return `${request}\n\nBattery: ${battery.name}\nInclude entry: ${
    battery.entry
  }\nNamespaces: ${battery.namespaces.join(", ") || "none"}${
    "server" in change ? serverLines(change.server) : ""
  }${"variable" in change ? `\nCredential variable: ${change.variable}` : ""}`;
}

/**
 * The prompt for the changes a battery's dialog saves together. One change
 * reads as it does alone. Several, each attaching the battery to a server or
 * detaching it from one, are asked for as a single change, with each server's
 * exact lines. A server's editor who may not update guardrails says so, since
 * their change goes through the servers' own batteries, not the policy.
 */
export function resolveOpenAppaBatteryChangesPrompt(
  changes: readonly OpenAppaBatteryChange[],
  options: { serverEditor?: boolean } = {},
): string | undefined {
  const [first] = changes;
  if (!first) return undefined;
  const servers = changes.flatMap((change) =>
    "server" in change
      ? [
          {
            attach: change.promptKey === "attachBattery",
            server: change.server,
          },
        ]
      : [],
  );
  const editor = options.serverEditor
    ? `\n\nI may edit ${servers.length > 1 ? "these servers" : "this server"} in the MCP registry, but I may not update the organization's guardrails. Propose it as a change to the ${servers.length > 1 ? "servers'" : "server's"} batteries.`
    : "";
  if (changes.length === 1)
    return `${resolveOpenAppaBatteryPrompt(first)}${editor}`;
  const { battery } = first;
  const steps = servers.map(
    ({ attach, server }) =>
      `- ${attach ? "Attach it to" : "Detach it from"} ${describeOpenAppaPolicyTarget("mcp_server", server.name)}.`,
  );
  const lines = servers.map(
    ({ attach, server }) =>
      `\n\nChange: ${attach ? "attach" : "detach"}\nServer: ${server.name}\nTarget type: mcp_server\nTarget ID: ${server.id}${
        server.toolPrefix ? `\nTool prefix: ${server.toolPrefix}` : ""
      }`,
  );
  return `Make these changes to the battery "${battery.name}" in my OpenAPPA policy, as one change in one pull request:\n${steps.join("\n")}\nPoint its namespaces at each attached server's tools in \`[aliases.mcp]\`, and remove each detached server from them. Add its entry to \`include\` if it is not there; if no server is left, take the entry out.\n\nBattery: ${battery.name}\nInclude entry: ${battery.entry}\nNamespaces: ${battery.namespaces.join(", ") || "none"}${lines.join("")}${editor}`;
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

function serverLines(server: {
  id: string;
  name: string;
  toolPrefix?: string;
}): string {
  return `${targetLines({ kind: "mcp_server", id: server.id, name: server.name })}${
    server.toolPrefix ? `\nTool prefix: ${server.toolPrefix}` : ""
  }`;
}

type BatteryChangeOf = {
  /** The battery: its name, include entry and namespaces. */
  battery: { name: string; entry: string; namespaces: string[] };
};

type ServerChangeOf = BatteryChangeOf & {
  /**
   * The MCP server, by its catalog entry, and the tool prefix the policy
   * already points the battery at, when it does.
   */
  server: { id: string; name: string; toolPrefix?: string };
};

function targetLines(target: OpenAppaLaunchTarget): string {
  return `\n\nTarget type: ${target.kind}\nTarget ID: ${target.id}${
    target.tool ? `\nTool: ${target.tool}` : ""
  }`;
}
