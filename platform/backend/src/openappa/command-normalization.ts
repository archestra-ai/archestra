/**
 * Checks whether a tool name refers to a command-execution tool.
 * @public — exported for testability
 */
export function isCommandExecutionTool(name: string): boolean {
  const stripped = localToolName(name).toLowerCase();
  return (
    stripped === "bash" ||
    stripped === "mcp__workspace__bash" ||
    stripped === "shell" ||
    stripped === "exec_command" ||
    stripped === "run_command" ||
    stripped === "cmd"
  );
}

/**
 * The arguments a call is evaluated with. A command tool gets `command` and
 * `cmd` set to one value, so a rule matches either client's spelling. Kimi
 * Code's Read, Write and Edit name the file `path`, while the coding
 * battery's rules for those tools (Claude Code's names) read `file_path`, and
 * a policy cannot map a second argument name onto the same tool. Such a call
 * also gets `file_path`, only when it has none. The copy spells the path with
 * forward slashes: on Windows the client sends `C:\Users\me\.npmrc`, and the
 * battery's selectors (`*\/.npmrc`) read `/`. So a `file_path` equal to the
 * `path` spelled that way is always this copy.
 */
export function normalizeToolArgumentsForPolicy(
  toolName: string,
  args: unknown,
): unknown {
  if (typeof args !== "object" || args === null) return args;
  const normalized = { ...(args as Record<string, unknown>) };
  if (isCommandExecutionTool(toolName)) {
    if (normalized.command !== undefined && normalized.cmd === undefined) {
      normalized.cmd = normalized.command;
    } else if (
      normalized.cmd !== undefined &&
      normalized.command === undefined
    ) {
      normalized.command = normalized.cmd;
    }
  }
  if (
    PATH_FILE_TOOLS.has(localToolName(toolName)) &&
    typeof normalized.path === "string" &&
    normalized.file_path === undefined
  ) {
    normalized.file_path = policyPath(normalized.path);
  }
  return normalized;
}

/**
 * A call's arguments without the copies `normalizeToolArgumentsForPolicy`
 * adds, for a reviewer who should see each value once.
 */
export function withoutArgumentCopies(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const copies = new Set<string>();
  if (isCommandExecutionTool(toolName) && args.cmd === args.command)
    copies.add("cmd");
  if (
    PATH_FILE_TOOLS.has(localToolName(toolName)) &&
    typeof args.path === "string" &&
    args.file_path === policyPath(args.path)
  )
    copies.add("file_path");
  if (copies.size === 0) return args;
  return Object.fromEntries(
    Object.entries(args).filter(([name]) => !copies.has(name)),
  );
}

// =============================================================================
// Internal helpers
// =============================================================================

// Kimi Code's file tools: Claude Code's names, with the file named `path`.
const PATH_FILE_TOOLS = new Set(["Read", "Write", "Edit"]);

function localToolName(name: string): string {
  return name.replace(/^(builtin:|host\/[^/]+\/)/, "");
}

// The path as the battery's selectors read it: `/` between the segments.
function policyPath(path: string): string {
  return path.replaceAll("\\", "/");
}
