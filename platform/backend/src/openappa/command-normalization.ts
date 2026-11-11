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
  if (normalized.command != null && normalized.cmd == null) {
    normalized.cmd = normalized.command;
  } else if (normalized.cmd != null && normalized.command == null) {
    normalized.command = normalized.cmd;
  }
  return normalized;
}

/**
 * The refusal for a call that spells one argument both ways with different
 * values, or null. The policy reads one spelling while the client's tool may
 * execute the other, so the call is refused before it is ruled on.
 */
export function argumentSpellingConflict(
  toolName: string,
  args: unknown,
): string | null {
  if (
    !isCommandExecutionTool(toolName) ||
    typeof args !== "object" ||
    args === null
  )
    return null;
  const { command, cmd } = args as Record<string, unknown>;
  if (command == null || cmd == null) return null;
  if (typeof command === "string" && typeof cmd === "string" && command === cmd)
    return null;
  return "[appa] Blocked: this call sets both `command` and `cmd`, to different values. The tool did not run. Make the call again with only the argument the tool defines.";
}

/**
 * A call's arguments without the copy `normalizeCommandExecutionArguments`
 * adds, for a reviewer who should see each value once.
 */
export function withoutArgumentCopies(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!isCommandExecutionTool(toolName) || args.cmd !== args.command)
    return args;
  return Object.fromEntries(
    Object.entries(args).filter(([name]) => name !== "cmd"),
  );
}
