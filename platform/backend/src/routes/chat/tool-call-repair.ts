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

/**
 * Best-effort, dependency-free repair for malformed tool-call argument JSON.
 *
 * Models sometimes emit otherwise-valid tool arguments with a stray trailing
 * token — an extra closing brace on a new line, trailing prose, a duplicated
 * value — which makes a strict `JSON.parse` reject the whole payload (e.g.
 * "Unexpected non-whitespace character after JSON"). In that case the intended
 * object is fully recoverable: it is the first complete, balanced JSON value in
 * the string, and everything after it is garbage.
 *
 * Returns a valid JSON string when the input already parses, or when the first
 * complete JSON value can be isolated and parses cleanly. Returns null when the
 * input can't be safely recovered this way (an unterminated string, a missing
 * brace, no JSON at all), leaving the caller to fall back to a heavier repair.
 */
export function repairMalformedToolInput(input: string): string | null {
  if (isParseableJson(input)) {
    return input;
  }
  const candidate = extractFirstJsonValue(input);
  if (candidate === null || candidate === input) {
    return null;
  }
  return isParseableJson(candidate) ? candidate : null;
}

function isParseableJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan from the first `{`/`[` and return the substring spanning the first
 * balanced, complete JSON value. String literals (and their escapes) are
 * tracked so structural characters inside string values don't affect nesting
 * depth. Returns null when no balanced value is found before the string ends.
 */
function extractFirstJsonValue(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) {
    return null;
  }
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === open) {
      depth++;
    } else if (char === close) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
