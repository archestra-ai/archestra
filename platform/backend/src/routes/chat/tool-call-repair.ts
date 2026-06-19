// Some models (notably OpenAI harmony-format models served via OpenRouter) leak
// a reasoning-channel token into the tool-name field, e.g.
// `archestra__run_command<|channel|>commentary` or `...<|constrain|>json`. The
// token is never part of a real tool name, so the call fails to match any
// registered tool and surfaces a NoSuchToolError. This strips the leaked token
// so the call can be re-mapped to the tool the model meant.

// A harmony sentinel token at the leak boundary. The set is the closed harmony
// special-token vocabulary — matching the exact names (not a generic `<|word|>`)
// keeps repair from firing on an arbitrary closed sentinel a non-harmony model
// might emit. The registered-tool exact-match below is the real safety gate; this
// only narrows what counts as a leak worth repairing. Extend if harmony grows.
const HARMONY_SENTINEL =
  /<\|(?:start|end|message|channel|constrain|return|call)\|>/;

/**
 * Strip a leaked harmony sentinel token from a tool name. Returns the cleaned
 * name only when a real harmony token is present AND the prefix matches a
 * registered tool; otherwise null (no repair — let the existing not-found path
 * handle it).
 */
export function repairHarmonyToolName(
  toolName: string,
  availableNames: Iterable<string>,
): string | null {
  const match = HARMONY_SENTINEL.exec(toolName);
  if (match === null) {
    return null;
  }
  // Only a suffix leak is expected (`NAME<|…`): a sentinel at index 0 leaves
  // nothing to map, and the prefix before the first token is the intended name.
  const cleaned = toolName.slice(0, match.index).trim();
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
