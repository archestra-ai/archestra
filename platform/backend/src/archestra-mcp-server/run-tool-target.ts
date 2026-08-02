import {
  ARCHESTRA_TOOL_SHORT_NAMES,
  type ArchestraToolShortName,
  getArchestraToolFullName,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";

import { archestraMcpBranding } from "./branding";

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
  if (!isRunToolName(toolName)) {
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

type RunToolDispatch =
  /** Not a `run_tool` call — the tool name is its own identity. */
  | { kind: "not_dispatch" }
  /** A `run_tool` dispatch whose target resolved to a canonical tool name. */
  | { kind: "target"; toolName: string }
  /**
   * A `run_tool` call whose target cannot be recovered — the call's arguments
   * were not captured, or carry no usable `tool_name`. The caller cannot know
   * which tool produced the result, so trust decisions must fail closed.
   */
  | { kind: "unresolved" };

/**
 * Classify a tool call for trust/policy purposes: pass-through for ordinary
 * tools, and for `run_tool` dispatches recover the target tool's canonical
 * name (bare Archestra short names like `run_command` are expanded to their
 * full `archestra__…` form, mirroring run_tool's own dispatch resolution) so
 * policies evaluate the tool that actually produced the data instead of the
 * built-in wrapper.
 */
/** True when the (canonical) tool name is the `run_tool` dispatch wrapper. */
function isRunToolName(toolName: string): boolean {
  return (
    archestraMcpBranding.getToolShortName(toolName) === TOOL_RUN_TOOL_SHORT_NAME
  );
}

export function resolveRunToolDispatch(
  toolName: string,
  args: unknown,
): RunToolDispatch {
  if (!isRunToolName(toolName)) {
    return { kind: "not_dispatch" };
  }

  const targetToolName = isRecord(args) ? args.tool_name : undefined;
  if (typeof targetToolName !== "string" || targetToolName.length === 0) {
    return { kind: "unresolved" };
  }

  return { kind: "target", toolName: resolveRunToolTargetName(targetToolName) };
}

/**
 * Resolve a run_tool target name to its canonical form (Archestra short names
 * like `run_command` → `archestra__run_command`; everything else unchanged),
 * mirroring run_tool's own resolution so dispatch and access checks line up.
 */
export function resolveRunToolTargetName(requestedName: string): string {
  const isArchestraPrefixed = archestraMcpBranding.isToolName(requestedName);
  if (!isArchestraPrefixed && ARCHESTRA_SHORT_NAME_SET.has(requestedName)) {
    return getArchestraToolFullName(requestedName as ArchestraToolShortName);
  }
  return requestedName;
}

const ARCHESTRA_SHORT_NAME_SET = new Set<string>(ARCHESTRA_TOOL_SHORT_NAMES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
