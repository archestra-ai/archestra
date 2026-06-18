// Some models (notably OpenAI harmony-format models served via OpenRouter) leak
// a reasoning-channel marker into the tool-name field, e.g.
// `archestra__run_command<|channel|>commentary`. The marker is never part of a
// real tool name, so the call fails to match any registered tool and surfaces a
// NoSuchToolError. This strips the marker so the call can be re-mapped to the
// tool the model meant.

// The exact harmony channel marker the model leaks into the function-name field
// (e.g. `...<|channel|>commentary`). Matching the full marker rather than a bare
// `<|` avoids re-mapping an arbitrary unknown name that merely happens to contain
// `<|`, which could otherwise execute a different tool than the model named.
const HARMONY_CHANNEL_MARKER = "<|channel|>";

/**
 * Strip a leaked harmony channel marker from a tool name. Returns the cleaned
 * name only when it differs from the original AND matches a registered tool;
 * otherwise null (no repair — let the existing not-found path handle it).
 */
export function repairHarmonyToolName(
  toolName: string,
  availableNames: Iterable<string>,
): string | null {
  const markerIndex = toolName.indexOf(HARMONY_CHANNEL_MARKER);
  if (markerIndex === -1) {
    return null;
  }
  const cleaned = toolName.slice(0, markerIndex).trim();
  if (cleaned === "") {
    return null;
  }
  for (const name of availableNames) {
    if (name === cleaned) {
      return cleaned;
    }
  }
  return null;
}
