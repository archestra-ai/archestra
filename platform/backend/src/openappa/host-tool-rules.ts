import { stringify as stringifyToml } from "smol-toml";
import logger from "@/logging";
import { asRecord, parsePolicyToml, toolEntries } from "./policy-text";

/** What the host's own rules depend on besides the composed document. */
export type HostToolContext = {
  /** The server name Archestra's own tools are ruled under, white-labeled or not. */
  serverName: string;
  /** Who may read what a Git-synced policy change publishes; null without Git sync. */
  gitSyncAudience: "internal" | "public" | null;
};

/**
 * The composed document with the rules the host writes for the tools it serves
 * itself.
 *
 * - `mcp/appa/yell`: the runtime rules a proxied `yell` under a name no
 *   battery declares. Without its own rule, `yell` falls to the catch-all: an
 *   annotator there must answer before the report runs, and a policy with no
 *   catch-all refuses it. `yell` is how a stuck session reaches a person.
 * - `mcp/<server>/read_peer_message`: the runtime admits a peer read only
 *   through an exact rule with an empty `delta`, so the reader receives the
 *   message under the label its sender captured.
 * - With Git sync, `update_guardrails_policy` and `update_guardrails_validation`
 *   open a change in the policy repository, so they also require an audience
 *   that holds the repository's readers. This rule replaces any other.
 *
 * The rules are part of the composition, so every process dispatches the same
 * bytes for it. An organization's own `yell` or peer read rule stands. When
 * the runtime refuses an added rule, the composition is kept without it.
 */
export async function withHostToolRules(params: {
  composed: string;
  host: HostToolContext;
  validate: (text: string) => Promise<string[]>;
}): Promise<string> {
  let text = params.composed;
  for (const rule of hostRules(params.host)) {
    text = await withRule({
      composed: text,
      rule,
      validate: params.validate,
    });
  }
  return text;
}

type HostRule = {
  entry: { name: string; delta: object; requires?: object };
  /** Whether the host's rule replaces one the document already has. */
  replaces: boolean;
};

/**
 * The host's rules, in the order they are prepended: the last one becomes the
 * document's first rule.
 */
function hostRules(host: HostToolContext): HostRule[] {
  const audience = host.gitSyncAudience;
  return [
    ...(audience === null
      ? []
      : ["update_guardrails_policy", "update_guardrails_validation"].map(
          (tool) => ({
            entry: {
              name: `mcp/${host.serverName}/${tool}`,
              delta: {},
              requires: {
                trust: "trusted",
                audience: { contains: [audience] },
              },
            },
            replaces: true,
          }),
        )),
    {
      entry: { name: `mcp/${host.serverName}/read_peer_message`, delta: {} },
      replaces: false,
    },
    { entry: { name: "mcp/appa/yell", delta: {} }, replaces: false },
  ];
}

async function withRule(params: {
  composed: string;
  rule: HostRule;
  validate: (text: string) => Promise<string[]>;
}): Promise<string> {
  const { composed, rule } = params;
  const { name } = rule.entry;
  if (
    !rule.replaces &&
    toolEntries(composed).some((entry) => entry.name === name)
  )
    return composed;
  const document = parsePolicyToml(composed);
  const policy = asRecord(document?.policy);
  if (!document || !policy) return composed;
  const tools = Array.isArray(policy.tool) ? policy.tool : [];
  // An exact name beats the catch-all wherever it is declared; first, it would
  // also win under a resolver that took the first match.
  policy.tool = [
    rule.entry,
    ...(rule.replaces
      ? tools.filter((tool) => !rulesTool(asRecord(tool)?.name, name))
      : tools),
  ];
  const text = stringifyToml(document);
  const errors = await params.validate(text);
  if (errors.length === 0) return text;
  logger.warn(
    { errors, tool: name },
    "OpenAPPA refused a host tool rule; the composition is kept without it",
  );
  return composed;
}

/** Whether a rule's name, with or without argument selectors, names `tool`. */
function rulesTool(ruleName: unknown, tool: string): boolean {
  return (
    typeof ruleName === "string" &&
    (ruleName === tool || ruleName.startsWith(`${tool}(`))
  );
}
