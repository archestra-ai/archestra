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

// Models occasionally emit malformed JSON for tool-call arguments — most
// commonly raw control characters (literal newlines/tabs) inside a large
// multi-line string value such as a skill's `content` blob. The AI SDK then
// throws an InvalidToolInputError before the tool handler runs, aborting the
// whole chat turn. The JSON spec forbids unescaped control characters (code
// points < 0x20) inside string literals, so escaping them is an unambiguous,
// loss-free repair we can apply deterministically.

const JSON_CONTROL_CHAR_ESCAPE: Record<number, string> = {
  8: "\\b",
  9: "\\t",
  10: "\\n",
  12: "\\f",
  13: "\\r",
};

/**
 * Attempt to deterministically repair malformed tool-call argument JSON by
 * escaping raw control characters that appear inside string literals. Returns
 * the repaired string ONLY if `JSON.parse` succeeds on the result; otherwise
 * returns null.
 *
 * Scope is intentionally narrow: it only rewrites control characters (< 0x20)
 * found inside an open string literal, tracking escape state so already-escaped
 * sequences (`\\n`, `\"`) are preserved verbatim and never double-escaped. It
 * does NOT try to guess unescaped inner quotes (too ambiguous) — that is left
 * to the model re-ask fallback. Returns null when the input already parses
 * (nothing to repair) or when the repaired result still does not parse.
 */
export function repairToolInputJson(raw: string): string | null {
  try {
    // Already valid — nothing to repair.
    try {
      JSON.parse(raw);
      return null;
    } catch {
      // fall through to repair attempt
    }

    let result = "";
    let inString = false;
    let escaped = false;

    for (let i = 0; i < raw.length; i++) {
      const char = raw[i];
      const code = raw.charCodeAt(i);

      if (escaped) {
        // Previous char was a backslash inside a string; emit this char as-is.
        result += char;
        escaped = false;
        continue;
      }

      if (inString) {
        if (char === "\\") {
          result += char;
          escaped = true;
          continue;
        }
        if (char === '"') {
          result += char;
          inString = false;
          continue;
        }
        if (code < 0x20) {
          // Raw control character inside a string literal — illegal in JSON.
          const known = JSON_CONTROL_CHAR_ESCAPE[code];
          result += known ?? `\\u${code.toString(16).padStart(4, "0")}`;
          continue;
        }
        result += char;
        continue;
      }

      // Outside a string literal. Control chars here are insignificant JSON
      // whitespace (or genuinely invalid); leave them untouched and let the
      // final JSON.parse be the arbiter.
      if (char === '"') {
        inString = true;
      }
      result += char;
    }

    try {
      JSON.parse(result);
      return result;
    } catch {
      return null;
    }
  } catch {
    // Any unexpected error — degrade to "no repair".
    return null;
  }
}
