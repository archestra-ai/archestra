import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@archestra/shared/consts";
import {
  CLIENT_MCP_TOOL_NAME_PREFIX,
  OPENCODE_MCP_TOOL_NAME_PREFIX,
} from "@archestra/shared/interactions/client";

/**
 * The client families whose own MCP server spellings the proxy can read.
 * The value is the family's filter id, which is also the first segment of a
 * detected server's id (`<family>.<label>`).
 */
export const DETECTED_CLIENT_FAMILIES = [
  "claude-code",
  "codex",
  "opencode",
] as const;

export type DetectedClientFamily = (typeof DETECTED_CLIENT_FAMILIES)[number];

/** A tool name read as `<label>` + `<tool>` on one client's wire. */
type DetectedToolName = { label: string; toolName: string };

/**
 * Reads a client's own MCP tool spelling, or returns undefined for a native
 * client tool, a delegation tool, or a label that cannot be an alias target.
 *
 * - Claude Code and Codex: `mcp__<label>__<tool>` (a Codex namespace member
 *   is persisted in this spelling).
 * - OpenCode: `mcp:<label>:<tool>`. Its other spelling, `<label>_<tool>`,
 *   cannot be split without knowing the label, so it is not read here.
 */
export function parseDetectedToolName(
  family: DetectedClientFamily,
  name: string,
): DetectedToolName | undefined {
  switch (family) {
    case "claude-code":
    case "codex":
      return parseDoubleUnderscoreSpelling(name);
    case "opencode":
      return parseOpenCodeColonSpelling(name);
  }
}

/**
 * OpenCode's `<label>_<tool>` spelling, resolved against labels an alias
 * target already declares for OpenCode. The longest declared label wins;
 * nothing is learned from the name itself.
 */
export function parseOpenCodeLabeledToolName(
  name: string,
  declaredLabels: Iterable<string>,
): DetectedToolName | undefined {
  let best: DetectedToolName | undefined;
  for (const label of declaredLabels) {
    const prefix = `${label}_`;
    if (
      name.length > prefix.length &&
      name.startsWith(prefix) &&
      (best === undefined || label.length > best.label.length)
    ) {
      best = { label, toolName: name.slice(prefix.length) };
    }
  }
  return best;
}

/** Splits a detected server id at its first `.`; the family set has no dots. */
export function parseDetectedServerId(
  id: string,
): { family: DetectedClientFamily; label: string } | undefined {
  const dot = id.indexOf(".");
  if (dot <= 0) return undefined;
  const family = id.slice(0, dot);
  const label = id.slice(dot + 1);
  if (!isDetectedClientFamily(family) || !isValidDetectedLabel(label)) {
    return undefined;
  }
  return { family, label };
}

/** `<family>.<label>`: the detected server's id and its alias target. */
export function detectedServerId(
  family: DetectedClientFamily,
  label: string,
): string {
  return `${family}.${label}`;
}

/**
 * Whether an alias target names a detected server: `<family>.<label>` with a
 * known family. A catalog's tool prefix never holds a dot, so the two cannot
 * be confused.
 */
export function isDetectedServerId(target: string): boolean {
  return parseDetectedServerId(target) !== undefined;
}

export function isDetectedClientFamily(
  value: string,
): value is DetectedClientFamily {
  return (DETECTED_CLIENT_FAMILIES as readonly string[]).includes(value);
}

/**
 * A label is valid when `<family>.<label>` is a segment OpenAPPA's alias
 * grammar accepts: ASCII letters, digits, `_`, `.`, `-`, and no `__`, which
 * the runtime reads as a server/tool separator. Invalid labels are never
 * normalised; the row is skipped.
 */
function isValidDetectedLabel(label: string): boolean {
  return (
    label.length > 0 &&
    SEGMENT_PATTERN.test(label) &&
    !label.includes(MCP_SERVER_TOOL_NAME_SEPARATOR)
  );
}

// === Internal helpers ===

const SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

function parseDoubleUnderscoreSpelling(
  name: string,
): DetectedToolName | undefined {
  if (!name.startsWith(CLIENT_MCP_TOOL_NAME_PREFIX)) return undefined;
  const rest = name.slice(CLIENT_MCP_TOOL_NAME_PREFIX.length);
  const separator = rest.indexOf(MCP_SERVER_TOOL_NAME_SEPARATOR);
  if (separator <= 0) return undefined;
  const label = rest.slice(0, separator);
  const toolName = rest.slice(
    separator + MCP_SERVER_TOOL_NAME_SEPARATOR.length,
  );
  // A second `__` leaves the split ambiguous, and the runtime splits a
  // canonical name at its last `__`, so such a tool could not be governed.
  if (
    toolName === "" ||
    toolName.includes(MCP_SERVER_TOOL_NAME_SEPARATOR) ||
    !isValidDetectedLabel(label)
  ) {
    return undefined;
  }
  return { label, toolName };
}

function parseOpenCodeColonSpelling(
  name: string,
): DetectedToolName | undefined {
  if (!name.startsWith(OPENCODE_MCP_TOOL_NAME_PREFIX)) return undefined;
  const rest = name.slice(OPENCODE_MCP_TOOL_NAME_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return undefined;
  const label = rest.slice(0, separator);
  const toolName = rest.slice(separator + 1);
  if (toolName === "" || !isValidDetectedLabel(label)) return undefined;
  return { label, toolName };
}
