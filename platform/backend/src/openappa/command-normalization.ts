import { stringify } from "smol-toml";
import { asRecord, parsePolicyToml } from "./policy-text";

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
 * Expands command tool policy rules across all tool names (`bash`, `shell`,
 * `exec_command`, `run_command`) and parameter names (`command`, `cmd`), so
 * a rule matches each client's own spelling of a command call. The aliases
 * are appended, so the authored rules keep their lines.
 */
export function expandCommandExecutionPolicyRules(content: string): string {
  const policy = asRecord(parsePolicyToml(content)?.policy);
  const rules = (Array.isArray(policy?.tool) ? policy.tool : []).flatMap(
    (tool) => {
      const rule = asRecord(tool);
      return rule && typeof rule.name === "string"
        ? [{ ...rule, name: rule.name }]
        : [];
    },
  );
  const names = new Set(rules.map((rule) => rule.name));
  const aliases: Record<string, unknown>[] = [];

  for (const rule of rules) {
    const spelled = rule.name.match(COMMAND_TOOL_NAME);
    if (!spelled) continue;
    const [, origPrefix, selector] = spelled;
    const conditions = selectorConditions(selector);
    const command = conditions.findIndex((condition) =>
      COMMAND_CONDITION.test(condition),
    );
    if (command === -1) continue;

    const prefixes =
      origPrefix.startsWith("host/") && origPrefix !== "host/archestra/"
        ? [origPrefix, ...COMMAND_PREFIXES]
        : COMMAND_PREFIXES;
    for (const prefix of prefixes) {
      for (const tool of COMMAND_TOOLS) {
        for (const param of COMMAND_PARAMS) {
          const renamed = conditions.map((condition, index) =>
            index === command
              ? condition.replace(COMMAND_CONDITION, param)
              : condition,
          );
          const name = `${prefix}${tool}(${renamed.join(",")})`;
          if (names.has(name)) continue;
          names.add(name);
          aliases.push({ ...rule, name });
        }
      }
    }
  }

  if (aliases.length === 0) return content;
  return `${content}\n\n# --- Expanded command execution tool aliases ---\n${stringify(
    { policy: { tool: aliases } },
  )}`;
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
