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
 * The arguments a call is evaluated with. A command tool gets `command` and
 * `cmd` set to one value, so a rule matches either client's spelling. Cursor's
 * Read, Write and StrReplace name the file `path`, while the coding battery's
 * rules for those tools read `file_path`, and a policy cannot map a second
 * argument name onto the same tool. Such a call also gets `file_path`, only
 * when it has none. The copy spells the path with forward slashes: on Windows
 * the client sends `C:\Users\me\.npmrc`, and the battery's selectors
 * (`*\/.npmrc`) read `/`. So a `file_path` equal to the `path` spelled that way
 * is always this copy.
 */
export function normalizeCommandExecutionArguments(
  toolName: string,
  args: unknown,
): unknown {
  if (typeof args !== "object" || args === null) return args;
  const command = isCommandExecutionTool(toolName);
  const pathTarget = pathFileTarget(localToolName(toolName));
  if (!command && pathTarget === null) return args;
  const normalized = { ...(args as Record<string, unknown>) };
  if (command) {
    if (normalized.command != null && normalized.cmd == null) {
      normalized.cmd = normalized.command;
    } else if (normalized.cmd != null && normalized.command == null) {
      normalized.command = normalized.cmd;
    }
  }
  if (
    pathTarget !== null &&
    typeof normalized.path === "string" &&
    normalized[pathTarget] == null
  ) {
    normalized[pathTarget] = policyPath(normalized.path);
  }
  return normalized;
}

/**
 * The refusal for a call that spells one argument both ways with different
 * values, or null. The policy reads one spelling while the client's tool may
 * execute the other, so the call is refused before it is ruled on. A value
 * equal to the normalizer's own copy of the other is the same value.
 */
export function argumentSpellingConflict(
  toolName: string,
  args: unknown,
): string | null {
  if (typeof args !== "object" || args === null) return null;
  const record = args as Record<string, unknown>;
  const pathTarget = pathFileTarget(localToolName(toolName));
  const spellings = isCommandExecutionTool(toolName)
    ? { ruled: "command", other: "cmd", copy: (value: string) => value }
    : pathTarget !== null
      ? { ruled: pathTarget, other: "path", copy: policyPath }
      : null;
  if (!spellings) return null;
  const { ruled, other, copy } = spellings;
  const [ruledValue, otherValue] = [record[ruled], record[other]];
  if (ruledValue == null || otherValue == null) return null;
  if (
    typeof ruledValue === "string" &&
    typeof otherValue === "string" &&
    (ruledValue === otherValue || ruledValue === copy(otherValue))
  )
    return null;
  return `[appa] Blocked: this call sets both \`${ruled}\` and \`${other}\`, to different values. The tool did not run. Make the call again with only the argument the tool defines.`;
}

/**
 * A call's arguments without the copies `normalizeCommandExecutionArguments`
 * adds, for a reviewer who should see each value once.
 */
export function withoutArgumentCopies(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const copies = new Set<string>();
  if (isCommandExecutionTool(toolName) && args.cmd === args.command)
    copies.add("cmd");
  const pathTarget = pathFileTarget(localToolName(toolName));
  if (
    pathTarget !== null &&
    typeof args.path === "string" &&
    args[pathTarget] === policyPath(args.path)
  )
    copies.add(pathTarget);
  if (copies.size === 0) return args;
  return Object.fromEntries(
    Object.entries(args).filter(([name]) => !copies.has(name)),
  );
}

// =============================================================================
// Internal helpers
// =============================================================================

// Cursor's Read, Write and StrReplace (`path` -> `file_path`).
function pathFileTarget(tool: string): "file_path" | null {
  return tool === "Read" || tool === "Write" || tool === "StrReplace"
    ? "file_path"
    : null;
}

function localToolName(name: string): string {
  return name.replace(/^(builtin:|host\/[^/]+\/)/, "");
}

// The path as the battery's selectors read it: `/` between the segments.
function policyPath(path: string): string {
  return path.replaceAll("\\", "/");
}
