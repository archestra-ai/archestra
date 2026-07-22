import { TOOL_RUN_TOOL_SHORT_NAME } from "@archestra/shared";

import { archestraMcpBranding } from "./branding";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unwrap a `run_tool` dispatch to the underlying tool it targets and that
 * tool's own arguments.
 *
 * `run_tool` is a meta wrapper: its args carry `tool_name` (the tool actually
 * being invoked) and `tool_args` (that tool's input). For any non-`run_tool`
 * call the tool name and args are returned unchanged. This mirrors the
 * resolution `run_tool` performs internally so that approval policy checks and
 * human-facing approval prompts describe the real target tool rather than the
 * opaque `run_tool` wrapper.
 */
export function resolveRunToolTarget(
  toolName: string,
  args: unknown,
): { toolName: string; toolInput: Record<string, unknown> } {
  const toolInput = isRecord(args) ? args : {};
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  if (shortName !== TOOL_RUN_TOOL_SHORT_NAME) {
    return { toolName, toolInput };
  }

  const targetToolName = toolInput.tool_name;
  if (typeof targetToolName !== "string" || targetToolName.length === 0) {
    return { toolName, toolInput };
  }

  const targetToolInput = isRecord(toolInput.tool_args)
    ? toolInput.tool_args
    : {};
  return {
    toolName: targetToolName,
    toolInput: targetToolInput,
  };
}
