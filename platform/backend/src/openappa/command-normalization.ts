import { parse as parseToml, stringify } from "smol-toml";
import { asRecord } from "./policy-text";

const COMMAND_TOOLS = [
  "bash",
  "Bash",
  "shell",
  "exec_command",
  "run_command",
] as const;

const COMMAND_PARAMS = ["command", "cmd"] as const;

const COMMAND_PREFIXES = ["builtin:", "host/archestra/"] as const;

const COMMAND_TOOL_NAME =
  /^((?:builtin:|host\/[^/]+\/)?)(?:bash|Bash|shell|exec_command|run_command)\((.*)\)$/s;

const COMMAND_CONDITION = /^(?:command|cmd)(?=:)/;

/**
 * Checks whether a tool name refers to a command-execution tool.
 * @public — exported for testability
 */
export function isCommandExecutionTool(name: string): boolean {
  const stripped = name.replace(/^(builtin:|host\/[^/]+\/)/, "").toLowerCase();
  return (
    stripped === "bash" ||
    stripped === "shell" ||
    stripped === "exec_command" ||
    stripped === "run_command" ||
    stripped === "cmd"
  );
}

/**
 * Aliases `command` and `cmd` arguments so command tools match policy
 * wildcard patterns across different client parameter names.
 */
export function normalizeCommandExecutionArguments(
  toolName: string,
  args: unknown,
): unknown {
  if (
    !isCommandExecutionTool(toolName) ||
    typeof args !== "object" ||
    args === null
  ) {
    return args;
  }
  const normalized = { ...(args as Record<string, unknown>) };
  if (normalized.command !== undefined && normalized.cmd === undefined) {
    normalized.cmd = normalized.command;
  } else if (normalized.cmd !== undefined && normalized.command === undefined) {
    normalized.command = normalized.cmd;
  }
  return normalized;
}

/**
 * Expands command tool policy rules across all tool names (`bash`, `shell`,
 * `exec_command`, `run_command`) and parameter names (`command`, `cmd`), so
 * a rule matches each client's own spelling of a command call. Contracts are
 * first-match in declaration order, so each alias stands right after the rule
 * it copies, ahead of any broader rule written after it. Without aliases a
 * call in another spelling would fall through to a broader rule, so a policy
 * this cannot read is refused rather than served unexpanded.
 */
export function expandCommandExecutionPolicyRules(content: string): string {
  const document = parseToml(content, { integersAsBigInt: "asNeeded" });
  const policy = asRecord(document.policy);
  if (!policy || !Array.isArray(policy.tool)) return content;

  const declared = new Set<string>();
  let expanded = false;
  const tool = policy.tool.flatMap((entry) => {
    const rule = asRecord(entry);
    if (!rule || typeof rule.name !== "string") return [entry];
    declared.add(rule.name);
    const aliases = commandAliases(rule.name).filter(
      (name) => !declared.has(name),
    );
    for (const name of aliases) declared.add(name);
    expanded ||= aliases.length > 0;
    return [entry, ...aliases.map((name) => ({ ...rule, name }))];
  });

  return expanded
    ? stringify({ ...document, policy: { ...policy, tool } })
    : content;
}

/** Every other spelling of a command rule's tool and command argument. */
function commandAliases(name: string): string[] {
  const spelled = name.match(COMMAND_TOOL_NAME);
  if (!spelled) return [];
  const [, origPrefix, selector] = spelled;
  const conditions = selectorConditions(selector);
  const commands = conditions.filter((condition) =>
    COMMAND_CONDITION.test(condition),
  ).length;
  if (commands === 0) return [];
  // A selector naming both spellings already matches either client.
  const command = conditions.findIndex((condition) =>
    COMMAND_CONDITION.test(condition),
  );
  const selectors =
    commands > 1
      ? [selector]
      : COMMAND_PARAMS.map((param) =>
          conditions
            .map((condition, index) =>
              index === command
                ? condition.replace(COMMAND_CONDITION, param)
                : condition,
            )
            .join(","),
        );

  const prefixes =
    origPrefix.startsWith("host/") && origPrefix !== "host/archestra/"
      ? [origPrefix, ...COMMAND_PREFIXES]
      : COMMAND_PREFIXES;
  return prefixes.flatMap((prefix) =>
    COMMAND_TOOLS.flatMap((tool) =>
      selectors.map((renamed) => `${prefix}${tool}(${renamed})`),
    ),
  );
}

/** A selector's `argument:pattern` conditions, split at unescaped commas. */
function selectorConditions(selector: string): string[] {
  const conditions = [""];
  let escaped = false;
  for (const char of selector) {
    if (char === "," && !escaped) {
      conditions.push("");
      continue;
    }
    escaped = char === "\\" && !escaped;
    conditions[conditions.length - 1] += char;
  }
  return conditions;
}
