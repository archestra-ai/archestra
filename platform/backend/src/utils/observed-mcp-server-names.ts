import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@archestra/shared/consts";
import {
  CLIENT_MCP_TOOL_NAME_PREFIX,
  OPENCODE_MCP_TOOL_NAME_PREFIX,
} from "@archestra/shared/interactions/client";

/** A tool name read as `<label>` + `<tool>`. */
type ObservedToolName = { label: string; toolName: string };

/**
 * Reads a client's own MCP tool spelling, whichever client sent it, or
 * returns undefined for a native client tool, a delegation tool, or a label
 * that cannot be an alias target.
 *
 * - `mcp__<label>__<tool>`: Claude Code and Codex (a Codex namespace member
 *   is persisted in this spelling).
 * - `mcp:<label>:<tool>`: OpenCode. Its other spelling, `<label>_<tool>`,
 *   cannot be split without knowing the label, so it is not read here.
 */
export function parseObservedToolName(
  name: string,
): ObservedToolName | undefined {
  return (
    parseDoubleUnderscoreSpelling(name) ?? parseOpenCodeColonSpelling(name)
  );
}

/** The prefix of every observed server's id. */
const OBSERVED_SERVER_ID_PREFIX = "observed.";

/**
 * `observed.<label>`: the observed server's id and its alias target. The
 * prefix keeps it apart from a gateway server of the same label.
 */
export function observedServerId(label: string): string {
  return `${OBSERVED_SERVER_ID_PREFIX}${label}`;
}

/**
 * A label is valid when `observed.<label>` is a segment OpenAPPA's alias
 * grammar accepts: ASCII letters, digits, `_`, `.`, `-`, and no `__`, which
 * the runtime reads as a server/tool separator. Invalid labels are never
 * normalised; the row is skipped.
 */
function isValidObservedLabel(label: string): boolean {
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
): ObservedToolName | undefined {
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
    !isValidObservedLabel(label)
  ) {
    return undefined;
  }
  return { label, toolName };
}

function parseOpenCodeColonSpelling(
  name: string,
): ObservedToolName | undefined {
  if (!name.startsWith(OPENCODE_MCP_TOOL_NAME_PREFIX)) return undefined;
  const rest = name.slice(OPENCODE_MCP_TOOL_NAME_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return undefined;
  const label = rest.slice(0, separator);
  const toolName = rest.slice(separator + 1);
  if (toolName === "" || !isValidObservedLabel(label)) return undefined;
  return { label, toolName };
}
