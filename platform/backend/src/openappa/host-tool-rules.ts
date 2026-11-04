import { stringify as stringifyToml } from "smol-toml";
import logger from "@/logging";
import { asRecord, parsePolicyToml, toolEntries } from "./policy-text";

/**
 * The composed document with an empty rule for each tool the host itself
 * serves, unless a rule already names it.
 *
 * - `mcp/appa/yell`: the runtime rules a proxied `yell` under a name no
 *   battery declares. Without its own rule, `yell` falls to the catch-all: an
 *   annotator there must answer before the report runs, and a policy with no
 *   catch-all refuses it. `yell` is how a stuck session reaches a person.
 * - `mcp/archestra/read_peer_message`: the runtime admits a peer read only
 *   through an exact rule with an empty `delta`, so the reader receives the
 *   message under the label its sender captured.
 *
 * The rules are part of the composition, so every process dispatches the same
 * bytes for it. A rule the organization wrote stands. When the runtime refuses
 * an added rule, the composition is kept without it.
 */
export async function withHostToolRules(params: {
  composed: string;
  validate: (text: string) => Promise<string[]>;
}): Promise<string> {
  let text = params.composed;
  for (const tool of HOST_TOOLS) {
    text = await withEmptyRule({
      composed: text,
      tool,
      validate: params.validate,
    });
  }
  return text;
}

async function withEmptyRule(params: {
  composed: string;
  tool: string;
  validate: (text: string) => Promise<string[]>;
}): Promise<string> {
  const { composed, tool } = params;
  if (toolEntries(composed).some((entry) => entry.name === tool))
    return composed;
  const document = parsePolicyToml(composed);
  const policy = asRecord(document?.policy);
  if (!document || !policy) return composed;
  // An exact name beats the catch-all wherever it is declared; first, it would
  // also win under a resolver that took the first match.
  policy.tool = [
    { name: tool, delta: {} },
    ...(Array.isArray(policy.tool) ? policy.tool : []),
  ];
  const text = stringifyToml(document);
  const errors = await params.validate(text);
  if (errors.length === 0) return text;
  logger.warn(
    { errors, tool },
    "OpenAPPA refused an empty host tool rule; the composition keeps no rule for it",
  );
  return composed;
}

// ===

/**
 * The names the runtime rules the host's own tools under. Yell comes last, so
 * it is prepended last and stays the document's first rule.
 */
const HOST_TOOLS = ["mcp/archestra/read_peer_message", "mcp/appa/yell"];
