// Some models (notably OpenAI harmony-format models served via OpenRouter) leak
// a reasoning-channel marker into the tool-name field, e.g.
// `archestra__run_command<|channel|>commentary`. The marker is never part of a
// real tool name, so the call fails to match any registered tool and surfaces a
// NoSuchToolError. This strips the marker so the call can be re-mapped to the
// tool the model meant.

// Harmony channel markers always open with this sequence, which never appears in
// a valid tool name. Everything from the first occurrence onward is dropped.
const HARMONY_MARKER = "<|";

/**
 * Strip a leaked harmony channel marker from a tool name. Returns the cleaned
 * name only when it differs from the original AND matches a registered tool;
 * otherwise null (no repair — let the existing not-found path handle it).
 */
export function repairHarmonyToolName(
  toolName: string,
  availableNames: Iterable<string>,
): string | null {
  const markerIndex = toolName.indexOf(HARMONY_MARKER);
  if (markerIndex === -1) {
    return null;
  }
  const cleaned = toolName.slice(0, markerIndex).trim();
  if (cleaned === "" || cleaned === toolName) {
    return null;
  }
  for (const name of availableNames) {
    if (name === cleaned) {
      return cleaned;
    }
  }
  return null;
}
