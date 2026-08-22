import {
  ARCHESTRA_TOOL_SHORT_NAMES,
  type ArchestraToolShortName,
  getArchestraToolFullName,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
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
/**
 * True when the tool name is the `run_tool` dispatch wrapper, including when an
 * MCP client has decorated it with its own label.
 *
 * Clients namespace a gateway's tools with the alias they were registered
 * under: Claude Code turns what the gateway advertised into
 * `mcp__<alias>__<advertised name>`. That alias is free text typed at
 * `claude mcp add` time, so it routinely matches no name the platform knows,
 * and the gateway's own branded prefix then sits a segment deeper than the
 * decoration-stripping canonicalizer reaches. A strict match misses the wrapper
 * entirely — and a missed wrapper is not a harmless miss: the dispatch is never
 * unwrapped, so policies are evaluated against an opaque name that matches no
 * `tools` row and **fail open**, instead of against the tool the call runs.
 *
 * Matching loosely is safe here, and only here. Recognizing a dispatch can only
 * ADD enforcement: it hands the target tool to policy evaluation in place of a
 * name nothing speaks for. It routes no call anywhere — a loosely matched name
 * is never used as a rewrite target, which stays strict in
 * `planDispatchModeToolCallRewrites` — and it confers no built-in policy
 * bypass, which stays on `archestraMcpBranding.isToolName`. That keeps the
 * standing rule in `branding.ts` intact: a loose match must not drive dispatch,
 * RBAC, or bypass decisions.
 *
 * Only suffixes that still carry a server prefix are considered, so a
 * third-party tool merely named `run_tool` is not mistaken for the wrapper —
 * the prefix has to be one the branding recognizes as ours.
 */
function isRunToolName(toolName: string): boolean {
  const segments = toolName.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
  for (let i = 0; i < segments.length - 1; i++) {
    const candidate = segments.slice(i).join(MCP_SERVER_TOOL_NAME_SEPARATOR);
    if (
      archestraMcpBranding.getToolShortName(candidate) ===
      TOOL_RUN_TOOL_SHORT_NAME
    ) {
      return true;
    }
  }
  return false;
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
