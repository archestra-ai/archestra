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
 * being invoked) and `tool_args` (that tool's input). For any call that
 * {@link resolveRunToolDispatch} does not read as a dispatch to a target, the
 * tool name and args are returned unchanged. This mirrors the resolution
 * `run_tool` performs internally so that approval policy checks and
 * human-facing approval prompts describe the real target tool rather than the
 * opaque `run_tool` wrapper.
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
   * `loose` marks a wrapper recognized only by the compat decoration scan:
   * nothing proves it is ours, so its target is taken as written and earns no
   * trust a proven wrapper would.
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
 * The wrapper is recognized strictly by default: the canonical name must be
 * the platform's own `run_tool`. `loose` also recognizes it behind a client
 * label (see {@link runToolMatch}); a wrapper found only that way never yields
 * a built-in or an expanded target.
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
  if (typeof targetToolName !== "string" || targetToolName.length === 0) {
    return { kind: "unresolved" };
  }

  if (match === "strict") {
    return {
      kind: "target",
      toolName: resolveRunToolTargetName(targetToolName),
    };
  }
  // Built-in status is the platform's to confer. A wrapper nothing proves is
  // ours must not hand it to the tool it names, so a built-in target leaves
  // the call as the wrapper it is.
  if (isBuiltInTarget(targetToolName)) {
    return { kind: "not_dispatch" };
  }
  return { kind: "target", toolName: targetToolName, loose: true };
}

/**
 * The tool a call through an unproven `run_tool` wrapper names, and that
 * tool's arguments: `toolName` is a wire spelling whose declaration carries
 * no effective attestation, recognized as the wrapper by the loose scan, the
 * strict match included (a bare lookalike reads as the wrapper too).
 *
 * The client may route such a call to the platform's real gateway, registered
 * twice or behind a replayed marker, and that gateway runs the target. So the
 * target is ruled on as well, in addition to the wrapper itself, never in its
 * place: that would hand a lookalike the target's policy identity. As with any
 * loose match, the target is taken as written and never as a built-in.
 * Undefined when the call is no such dispatch or names no usable target.
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
 * How a tool name reads as the `run_tool` dispatch wrapper: `strict` when its
 * canonical name is the platform's own wrapper, `loose` when only the compat
 * decoration scan finds it.
 *
 * Canonical names come from the proxy's gateway tool identity, which resolves
 * an attested declaration to the name the gateway advertised whatever label
 * the client gave it. A strict match is therefore enough for every request
 * that carries a valid attestation, and it is the default.
 *
 * The loose scan exists only for compat requests, which carry no valid
 * attestation: there a client label (Claude Code's `mcp__<alias>__…`,
 * OpenCode's `<alias>_…`) may still sit in front of our branded prefix, and a
 * missed wrapper leaves policies evaluating an opaque name that fails open.
 * Nothing proves such a wrapper is ours, though: any server connected to the
 * client can name a tool that way. So a loose match only ever hands the target
 * to policy evaluation as written. It never yields a built-in or an expanded
 * target (see {@link resolveRunToolDispatch}), and trusted-data evaluation
 * never extends it the unknown-target trust a proven wrapper earns.
 *
 * Only suffixes that still carry a server prefix are considered, so a
 * third-party tool merely named `run_tool` is not mistaken for the wrapper —
 * the prefix has to be one the branding recognizes as ours.
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
