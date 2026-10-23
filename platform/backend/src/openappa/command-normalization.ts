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
