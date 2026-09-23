const COMMAND_TOOLS = [
  "bash",
  "Bash",
  "shell",
  "exec_command",
  "run_command",
] as const;

const COMMAND_PARAMS = ["command", "cmd"] as const;

const COMMAND_PREFIXES = ["builtin:", "host/archestra/"] as const;

const COMMAND_TOOL_REGEX =
  /^((?:builtin:|host\/[^/]+\/)?)(bash|Bash|shell|exec_command|run_command)\((command|cmd):([^)]+)\)$/;

const NAME_REGEX = /^([\t ]*name[\t ]*=[\t ]*")([^"\r\n]+)(")/m;

const TABLE_HEADER_REGEX =
  /^[\t ]*(?:\[\[[\t ]*([^\]\r\n]+?)[\t ]*\]\]|\[[\t ]*([^\]\r\n]+?)[\t ]*\])[\t ]*(?:#.*)?\r?$/gm;

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
 * `exec_command`, `run_command`) and parameter names (`command`, `cmd`).
 * This makes sure policies evaluate consistently across clients.
 */
export function expandCommandExecutionPolicyRules(content: string): string {
  const blocks = policyToolRuleBlocks(content);
  if (blocks.length === 0) return content;

  const existingNames = new Set<string>();
  for (const block of blocks) {
    const match = toolRuleNameMatch(block);
    if (match) existingNames.add(match[2]);
  }

  const newBlocks: string[] = [];

  for (const block of blocks) {
    const match = toolRuleNameMatch(block);
    if (!match) continue;
    const fullName = match[2];
    const parsed = fullName.match(COMMAND_TOOL_REGEX);
    if (!parsed) continue;

    const [, origPrefix, , , pattern] = parsed;
    const prefixes =
      origPrefix.startsWith("host/") &&
      !origPrefix.startsWith("host/archestra/")
        ? [origPrefix, ...COMMAND_PREFIXES]
        : COMMAND_PREFIXES;

    for (const prefix of prefixes) {
      for (const tool of COMMAND_TOOLS) {
        for (const param of COMMAND_PARAMS) {
          const aliasName = `${prefix}${tool}(${param}:${pattern})`;
          if (!existingNames.has(aliasName)) {
            existingNames.add(aliasName);
            const aliasBlock = replaceToolRuleName(block, match, aliasName);
            newBlocks.push(
              `\n${aliasBlock}${aliasBlock.endsWith("\n") ? "" : "\n"}`,
            );
          }
        }
      }
    }
  }

  return (
    content +
    (newBlocks.length > 0
      ? "\n# --- Expanded command execution tool aliases ---\n" +
        newBlocks.join("")
      : "")
  );
}

function toolRuleNameMatch(block: string): RegExpMatchArray | null {
  for (const header of block.matchAll(TABLE_HEADER_REGEX)) {
    if (header.index > 0) {
      return block.slice(0, header.index).match(NAME_REGEX);
    }
  }
  return block.match(NAME_REGEX);
}

function replaceToolRuleName(
  block: string,
  match: RegExpMatchArray,
  aliasName: string,
): string {
  const valueStart = (match.index ?? 0) + match[1].length;
  const valueEnd = valueStart + match[2].length;
  return block.slice(0, valueStart) + aliasName + block.slice(valueEnd);
}

function policyToolRuleBlocks(content: string): string[] {
  const blocks: string[] = [];
  let ruleStart: number | null = null;

  for (const match of content.matchAll(TABLE_HEADER_REGEX)) {
    const path = (match[1] ?? match[2]).replace(/[\t ]/g, "");
    const isToolRule = match[1] !== undefined && path === "policy.tool";
    const isToolSubtable = path.startsWith("policy.tool.");

    if (ruleStart !== null && !isToolSubtable) {
      blocks.push(content.slice(ruleStart, match.index));
      ruleStart = null;
    }
    if (isToolRule) ruleStart = match.index;
  }

  if (ruleStart !== null) blocks.push(content.slice(ruleStart));
  return blocks;
}
