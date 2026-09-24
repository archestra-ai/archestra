/**
 * Every setup rule makes a call wait for a person. They differ in when:
 *
 * - `flow`: after one tool brings in outside content, another tool asks.
 * - `audience`: after one tool reads internal data, a tool that shares it
 *   publicly asks.
 * - `tool`: one tool asks on every call.
 * - `repeat`: one tool runs once, then asks on every further call.
 */
export type SetupShape = "flow" | "audience" | "tool" | "repeat";

/** Shapes that pick a source tool before the guarded one. */
export function hasSource(shape: SetupShape): boolean {
  return shape === "flow" || shape === "audience";
}

export interface SetupRule {
  shape: SetupShape;
  /** Full tool name the first step calls. `flow` and `audience` only. */
  source?: string;
  /** Full tool name whose calls wait for a person. */
  guarded: string;
}

const REVIEWER = "setup-reviewer";
/**
 * Scopes the reviewers to the tools this setup asks about. An untagged
 * authority may approve a gap on any tool, including ones another rule means
 * to block.
 */
const REVIEW_TAG = "setup-review";

/**
 * The policy text the setup wizard adds. The guarded tool is tagged for a
 * human reviewer who approves each call:
 *
 * - `flow`: the source lowers trust; the guarded tool requires it.
 * - `audience`: the source narrows readers to `internal`; the guarded tool
 *   requires `public`.
 * - `tool`: the guarded tool requires the reviewer's attention mark.
 * - `repeat`: the guarded tool records an effect and excludes it, so only the
 *   first call runs freely. An effect exception is granted per effect, so each
 *   `repeat` rule declares its own reviewer.
 *
 * The shared reviewer is declared once per policy.
 */
export function setupRuleText(rule: SetupRule, existing = ""): string {
  const lines = ["# Added by OpenAPPA setup."];
  if (hasSource(rule.shape) && rule.source)
    lines.push(
      "[[policy.tool]]",
      `name = ${JSON.stringify(rule.source)}`,
      rule.shape === "flow"
        ? 'delta = { trust = "suspicious" }'
        : 'delta = { audience = ["internal"] }',
      "",
    );
  lines.push(
    "[[policy.tool]]",
    `name = ${JSON.stringify(rule.guarded)}`,
    `tags = ["${REVIEW_TAG}"]`,
    "delta = {}",
  );
  const authorities: { name: string; permits: string; hint: string }[] = [];
  if (rule.shape === "repeat") {
    const effect = JSON.stringify(`setup.${rule.guarded}.ran`);
    lines.push(
      `effects = [${effect}]`,
      `requires = { effects = { excludes = [${effect}] } }`,
    );
    authorities.push({
      name: `setup-repeat-${rule.guarded
        .replace(/[^A-Za-z0-9_-]+/g, "-")
        .replace(/^-|-$/g, "")}`,
      permits: `{ effects_containing = [${effect}] }`,
      hint: "This tool already ran in this conversation. Approve only if running it again is what you expect.",
    });
  } else {
    lines.push(
      rule.shape === "flow"
        ? 'requires = { trust = "trusted" }'
        : rule.shape === "audience"
          ? 'requires = { audience = { contains = ["public"] } }'
          : `requires = { attention = ["${REVIEW_TAG}"] }`,
    );
    authorities.push({
      name: REVIEWER,
      permits: `{ trust_below = "trusted", audience_missing = ["public"], attention = ["${REVIEW_TAG}"] }`,
      hint: "Approve only if this call is what you expect. Each call asks again.",
    });
  }
  for (const authority of authorities) {
    if (existing.includes(`[externals.authorities.${authority.name}]`))
      continue;
    lines.push(
      "",
      "[[policy.authority]]",
      `name = "${authority.name}"`,
      `hint = ${JSON.stringify(authority.hint)}`,
      `tags = ["${REVIEW_TAG}"]`,
      `permits = ${authority.permits}`,
      "",
      `[externals.authorities.${authority.name}]`,
      'builtin = "hitl"',
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The current policy with the setup rule appended, and the 1-based lines the
 * rule takes in it.
 */
export function withSetupRule(
  content: string,
  rule: SetupRule,
): { content: string; added: { from: number; to: number } } {
  const base = content.trimEnd();
  const text = setupRuleText(rule, content);
  const from = base.split("\n").length + 2;
  return {
    content: `${base}\n\n${text}`,
    added: { from, to: from + text.trimEnd().split("\n").length - 1 },
  };
}
