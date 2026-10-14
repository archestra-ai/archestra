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
      (alias) => !declared.has(alias.name),
    );
    for (const alias of aliases) declared.add(alias.name);
    expanded ||= aliases.length > 0;
    return [
      entry,
      ...aliases.map((alias) => ({
        ...rule,
        name: alias.name,
        ...(rule.parameters === undefined
          ? {}
          : { parameters: renamedParameter(rule.parameters, alias) }),
      })),
    ];
  });

  return expanded
    ? stringify({ ...document, policy: { ...policy, tool } })
    : content;
}

type CommandParam = (typeof COMMAND_PARAMS)[number];

type CommandAlias = { name: string; from: CommandParam; to: CommandParam };

/** Every other spelling of a command rule's tool and command argument. */
function commandAliases(name: string): CommandAlias[] {
  const spelled = name.match(COMMAND_TOOL_NAME);
  if (!spelled) return [];
  const [, origPrefix, selector] = spelled;
  const conditions = selectorConditions(selector);
  const command = conditions.findIndex((condition) =>
    COMMAND_CONDITION.test(condition),
  );
  if (command === -1) return [];
  const from: CommandParam = conditions[command].startsWith("cmd:")
    ? "cmd"
    : "command";

  const prefixes =
    origPrefix.startsWith("host/") && origPrefix !== "host/archestra/"
      ? [origPrefix, ...COMMAND_PREFIXES]
      : COMMAND_PREFIXES;
  return prefixes.flatMap((prefix) =>
    COMMAND_TOOLS.flatMap((tool) =>
      COMMAND_PARAMS.map((to) => {
        const renamed = conditions.map((condition, index) =>
          index === command
            ? condition.replace(COMMAND_CONDITION, to)
            : condition,
        );
        return { name: `${prefix}${tool}(${renamed.join(",")})`, from, to };
      }),
    ),
  );
}

/** A rule's `parameters` schema with the command argument under the alias's spelling. */
function renamedParameter(parameters: unknown, alias: CommandAlias): unknown {
  const schema = asRecord(parameters);
  if (!schema || alias.from === alias.to) return parameters;
  const rename = (key: string) => (key === alias.from ? alias.to : key);
  const properties = asRecord(schema.properties);
  return {
    ...schema,
    ...(properties
      ? {
          properties: Object.fromEntries(
            Object.entries(properties).map(([key, value]) => [
              rename(key),
              value,
            ]),
          ),
        }
      : {}),
    ...(Array.isArray(schema.required)
      ? { required: schema.required.map(rename) }
      : {}),
  };
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
