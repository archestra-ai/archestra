import { stringify as stringifyToml } from "smol-toml";
import logger from "@/logging";
import { asRecord, parsePolicyToml, toolEntries } from "./policy-text";

/**
 * The composed document with an empty rule for `yell`, unless a rule already
 * names it.
 *
 * The runtime rules a proxied `yell` as `mcp/appa/yell`, a name no battery
 * declares. Without its own rule, `yell` falls to the catch-all: an annotator
 * there must answer before the report runs, and a policy with no catch-all
 * refuses it. `yell` is how a stuck session reaches a person, so it keeps an
 * empty rule. A rule the organization wrote for it stands. When the runtime
 * refuses the added rule, the composition is kept as it was.
 */
export async function withReportingTool(params: {
  composed: string;
  validate: (text: string) => Promise<string[]>;
}): Promise<string> {
  const { composed } = params;
  if (toolEntries(composed).some((tool) => tool.name === REPORTING_TOOL))
    return composed;
  const document = parsePolicyToml(composed);
  const policy = asRecord(document?.policy);
  if (!document || !policy) return composed;
  // An exact name beats the catch-all wherever it is declared; first, it would
  // also win under a resolver that took the first match.
  policy.tool = [
    { name: REPORTING_TOOL, delta: {} },
    ...(Array.isArray(policy.tool) ? policy.tool : []),
  ];
  const text = stringifyToml(document);
  const errors = await params.validate(text);
  if (errors.length === 0) return text;
  logger.warn(
    { errors },
    "OpenAPPA refused the empty yell rule; the composition keeps no rule for yell",
  );
  return composed;
}

// ===

/** The name the runtime rules a proxied `yell` under. */
const REPORTING_TOOL = "mcp/appa/yell";
