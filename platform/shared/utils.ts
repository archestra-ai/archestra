import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "./consts";

export function formatSecretStorageType(
  storageType: "vault" | "external_vault" | "database" | "none" | undefined,
): string {
  switch (storageType) {
    case "vault":
      return "Vault";
    case "external_vault":
      return "External Vault";
    case "database":
      return "Database";
    default:
      return "None";
  }
}

/**
 * Slugify a name to create a URL-safe identifier
 * Used for generating tool names from prompt/agent names
 */
export function slugify(name: string): string {
  const slugified = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  // Trim leading and trailing underscores without backtracking regex
  let start = 0;
  let end = slugified.length;
  while (start < end && slugified[start] === "_") start++;
  while (end > start && slugified[end - 1] === "_") end--;

  return slugified.slice(start, end);
}

/**
 * Slugify a name to create a URL-friendly slug with hyphens.
 * Used for generating human-readable URL identifiers (e.g., MCP gateway slugs).
 */
export function urlSlugify(name: string): string {
  const slugified = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Trim leading and trailing hyphens without backtracking regex
  let start = 0;
  let end = slugified.length;
  while (start < end && slugified[start] === "-") start++;
  while (end > start && slugified[end - 1] === "-") end--;

  return slugified.slice(start, end);
}

/**
 * Parse a fully-qualified MCP tool name into server name and raw tool name.
 * Splits on the last separator so server names can themselves contain "__".
 */
export function parseFullToolName(fullName: string): {
  serverName: string | null;
  toolName: string;
} {
  const index = fullName.lastIndexOf(MCP_SERVER_TOOL_NAME_SEPARATOR);
  if (index <= 0) {
    return { serverName: null, toolName: fullName };
  }

  return {
    serverName: fullName.substring(0, index),
    toolName: fullName.substring(index + MCP_SERVER_TOOL_NAME_SEPARATOR.length),
  };
}

export function buildFullToolName(
  serverName: string,
  toolName: string,
): string {
  return `${serverName}__${toolName}`;
}

// ============================================================================
// Text shaping
// ============================================================================

/**
 * Collapse every run of whitespace — newlines included — into a single space,
 * and trim. The one-line form of text that has to sit on a single row: a
 * conversation title, a skill description, or a name interpolated into a prompt
 * line that a newline would otherwise let it break out of.
 */
export function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Drop the quotes or backticks a model wraps around the single value it was
 * asked for (`"Reviews pull requests."`). Only the outer run at each end goes;
 * quotes inside the text are part of the text.
 */
export function stripWrappingQuotes(value: string): string {
  return value.replace(/^["'`]+|["'`]+$/g, "").trim();
}

/**
 * Whether `value` is longer than `maxChars` **code points**.
 *
 * `String.length` counts UTF-16 units, so it over-counts everything outside the
 * BMP — one emoji reads as two. Measuring a character budget with it both
 * rejects text that actually fits and, when the same measure drives a slice,
 * cuts inside a surrogate pair.
 */
export function exceedsCharLimit(value: string, maxChars: number): boolean {
  // One code point is never fewer than one UTF-16 unit, so this many units can
  // never exceed the budget — and the common short string skips the scan below.
  if (value.length <= maxChars) {
    return false;
  }

  return [...boundedHead(value, maxChars)].length > maxChars;
}

/**
 * The first `maxChars` **code points** of `value`, or `value` unchanged when it
 * already fits. Never splits a surrogate pair, so the result cannot end in half
 * an emoji.
 */
export function truncateChars(value: string, maxChars: number): string {
  if (!exceedsCharLimit(value, maxChars)) {
    return value;
  }

  return [...boundedHead(value, maxChars)].slice(0, maxChars).join("");
}

/**
 * {@link truncateChars} with a trailing `…` marking the cut. The budget covers
 * the kept text only — the ellipsis is added on top — and a space left dangling
 * at the cut is dropped rather than padded back out.
 */
export function truncateCharsWithEllipsis(
  value: string,
  maxChars: number,
): string {
  if (!exceedsCharLimit(value, maxChars)) {
    return value;
  }

  return `${truncateChars(value, maxChars).trimEnd()}…`;
}

// ===== Internal =====

/**
 * A prefix of `value` that holds more than `maxChars` code points whenever
 * `value` itself does: a code point is at most two UTF-16 units, so
 * `2 * maxChars + 2` units always cover at least `maxChars + 1` of them. The
 * prefix may end in an unpaired surrogate, which is harmless — every caller
 * keeps at most `maxChars` entries, and that split unit sits past the cut.
 *
 * Bounding before spreading is what keeps counting proportional to the budget
 * instead of the input. Callers cap at a few dozen to a few thousand
 * characters, but the input can be a multi-megabyte paste, and spreading that
 * whole string materializes one array entry per code point to keep a handful.
 */
function boundedHead(value: string, maxChars: number): string {
  return value.slice(0, maxChars * 2 + 2);
}
