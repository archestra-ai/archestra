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
 * `run_tool` is a dispatch wrapper whose arguments contain `tool_name` and
 * `tool_args`. For any call that {@link resolveRunToolDispatch} does not read
 * as a dispatch to a target, the tool name and arguments return unchanged.
 * This mirrors internal `run_tool` resolution so policy checks and approval
 * prompts describe the actual target tool instead of the `run_tool` wrapper.
 */
export function resolveRunToolTarget(params: {
  toolName: string;
  args: unknown;
  /** Compat only; see {@link resolveRunToolDispatch}. */
  loose?: boolean;
}): { toolName: string; toolInput: Record<string, unknown> } {
  const toolInput = isRecord(params.args) ? params.args : {};
  const targetToolName = toolInput.tool_name;
  if (
    resolveRunToolDispatch(params).kind !== "target" ||
    typeof targetToolName !== "string"
  ) {
    return { toolName: params.toolName, toolInput };
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
  /**
   * A `run_tool` dispatch whose target resolved to a canonical tool name.
   * `loose` marks a wrapper recognized only by compat decoration scanning.
   * Because provenance is unverified, its target is evaluated as written
   * and receives no extra trust.
   */
  | { kind: "target"; toolName: string; loose?: true }
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
 *
 * By default, the wrapper requires a strict match to the platform `run_tool`.
 * When `loose` is enabled, the scanner also recognizes client prefixes
 * (see {@link runToolMatch}). A wrapper identified only by loose matching
 * never resolves to a built-in or expanded target.
 */
export function resolveRunToolDispatch(params: {
  toolName: string;
  args: unknown;
  loose?: boolean;
}): RunToolDispatch {
  const match = runToolMatch(params.toolName, params.loose === true);
  if (!match) {
    return { kind: "not_dispatch" };
  }

  const targetToolName = isRecord(params.args)
    ? params.args.tool_name
    : undefined;
  if (
    typeof targetToolName !== "string" ||
    targetToolName.length === 0 ||
    /\s/.test(targetToolName)
  ) {
    return { kind: "unresolved" };
  }

  if (match === "strict") {
    return {
      kind: "target",
      toolName: resolveRunToolTargetName(targetToolName),
    };
  }
  // The platform controls built-in status. An unverified wrapper cannot grant
  // built-in status to the tool it names. A built-in target remains evaluated
  // as the wrapper itself.
  if (isBuiltInTarget(targetToolName)) {
    return { kind: "not_dispatch" };
  }
  return { kind: "target", toolName: targetToolName, loose: true };
}

/**
 * Resolves the target tool and arguments for an unverified `run_tool` wrapper.
 * `toolName` is a wire spelling without a verified attestation that matches
 * the wrapper under loose scanning.
 *
 * Clients might route this call to a platform gateway that executes the target.
 * The policy evaluates the target in addition to the wrapper itself, rather than
 * replacing the wrapper. The target is evaluated as written and never as a
 * built-in tool. Returns undefined if the call is not a valid dispatch.
 */
export function resolveUnprovenRunToolTarget(params: {
  toolName: string;
  args: unknown;
}): { toolName: string; toolInput: Record<string, unknown> } | undefined {
  if (!runToolMatch(params.toolName, true) || !isRecord(params.args)) {
    return undefined;
  }
  const targetToolName = params.args.tool_name;
  if (
    typeof targetToolName !== "string" ||
    targetToolName.length === 0 ||
    isBuiltInTarget(targetToolName)
  ) {
    return undefined;
  }
  return {
    toolName: targetToolName,
    toolInput: isRecord(params.args.tool_args) ? params.args.tool_args : {},
  };
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

/**
 * Determines whether a tool name matches the `run_tool` dispatch wrapper.
 * Returns `strict` when the canonical name matches the platform wrapper.
 * Returns `loose` when matched through compatibility prefix scanning.
 *
 * Canonical names resolve verified gateway declarations to advertised names
 * regardless of client labels. A strict match handles all requests with valid
 * attestations.
 *
 * The loose scan supports unverified legacy requests where client prefixes
 * (such as Claude Code `mcp__<alias>__` or OpenCode `<alias>_`) precede the
 * branded tool name. Without loose matching, policies would evaluate an
 * unknown wrapper name and fail open. Loose matches provide target tools to
 * policies as written, without granting built-in status or extra trust.
 *
 * Only suffixes with recognized platform branding prefixes match, preventing
 * third-party tools named `run_tool` from matching.
 */
function runToolMatch(
  toolName: string,
  loose: boolean,
): "strict" | "loose" | undefined {
  if (isRunToolWrapper(toolName)) {
    return "strict";
  }
  if (!loose) {
    return undefined;
  }
  const segments = toolName.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
  for (let i = 1; i < segments.length - 1; i++) {
    const candidate = segments.slice(i).join(MCP_SERVER_TOOL_NAME_SEPARATOR);
    if (isRunToolWrapper(candidate)) {
      return "loose";
    }
  }
  // OpenCode joins its alias with a single underscore
  // (`<alias>_archestra__run_tool`), so the branded prefix starts mid-segment.
  for (let i = toolName.indexOf("_"); i > 0; i = toolName.indexOf("_", i + 1)) {
    if (isRunToolWrapper(toolName.slice(i + 1))) {
      return "loose";
    }
  }
  return undefined;
}

/** A target that names one of the platform's built-ins, bare or branded. */
function isBuiltInTarget(targetToolName: string): boolean {
  return (
    archestraMcpBranding.isToolName(targetToolName) ||
    ARCHESTRA_SHORT_NAME_SET.has(targetToolName)
  );
}

function isRunToolWrapper(candidate: string): boolean {
  return (
    archestraMcpBranding.getToolShortName(candidate) ===
    TOOL_RUN_TOOL_SHORT_NAME
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
