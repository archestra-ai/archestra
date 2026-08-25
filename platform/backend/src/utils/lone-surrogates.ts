/**
 * Repair of unpaired UTF-16 surrogates in text that has to survive leaving the
 * process — an outbound provider request, or a row on its way into Postgres.
 *
 * A surrogate pair encodes one astral character (emoji, rarer CJK, many
 * symbols) as two UTF-16 code units. Split the pair — by slicing, truncating or
 * eliding text at a raw code-unit offset — and a lone half is left behind.
 * `JSON.stringify` emits it as a bare `\uD83D` escape. That escape is ASCII, so
 * the JSON *text* is well-formed and travels intact — but decoding it yields an
 * unpaired surrogate, which has no UTF-8 representation. Strict server-side
 * parsers refuse the escape rather than produce an unrepresentable string, so
 * the whole body is rejected: Bedrock reports a 400 "the request body is not
 * valid JSON", the direct Anthropic API "no low surrogate in string".
 *
 * That alone would be a transient failure. What makes it a trap is that the
 * offending text is usually a *stored* turn — a tool result, an assistant
 * message — and every later turn replays the full transcript. So one stranded
 * half wedges the conversation permanently: each retry resends it and is
 * rejected identically, and the only escape is abandoning the history and
 * starting a new chat.
 *
 * Postgres is the second victim: `jsonb`/`text` are UTF-8, so a lone surrogate
 * makes an insert fail with "invalid input syntax for type json" and the row is
 * lost outright.
 *
 * Producers are fixed at the source where we own them (see
 * `buildAppliedEditExcerpts`), but the text we handle also comes from places we
 * never shaped: third-party MCP tool output truncated mid-character by the
 * server that produced it, pasted content, upstream completions cut at a token
 * boundary. Repairing at these boundaries keeps one bad character from costing
 * a conversation or a stored message.
 *
 * Substitution, not removal: U+FFFD is what every standard decoder yields for
 * an unpaired surrogate, it keeps offsets stable for anything counting
 * characters, and it leaves the damage visible rather than silently closing the
 * gap.
 */

/**
 * A high surrogate with no low surrogate after it, or a low with no high
 * before it. Well-formed pairs never match, so text without astral characters —
 * and text whose astral characters are intact — is left exactly as it was.
 */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** The same pattern, global, for replacement. Kept separate from the test-only
 * copy so neither call has to manage the other's `lastIndex`. */
const LONE_SURROGATE_ALL = new RegExp(LONE_SURROGATE, "g");

/** U+FFFD REPLACEMENT CHARACTER, the standard stand-in for undecodable input. */
const REPLACEMENT = "�";

type LoneSurrogateRepair = {
  /** The input, or a repaired copy when `repaired` is greater than zero. */
  value: unknown;
  /** How many lone surrogates were replaced. Zero means `value` is the input. */
  repaired: number;
};

/**
 * Repair one string. For callers already walking a structure for their own
 * reasons, so the traversal is not paid for twice.
 */
export function repairLoneSurrogateText(text: string): string {
  if (!LONE_SURROGATE.test(text)) return text;
  return text.replace(LONE_SURROGATE_ALL, REPLACEMENT);
}

/**
 * Walk a value and replace every unpaired surrogate in it.
 *
 * Structure-sharing: a subtree containing nothing to repair is returned by
 * reference, so a clean request — the overwhelming majority — is not copied at
 * all and the cost is one regex scan per string.
 *
 * Only plain objects and arrays are traversed. Class instances (Buffer, typed
 * arrays, Date, streams) are passed through untouched: they are not places a
 * JSON string lives, and cloning them would be both wasteful and lossy.
 */
export function repairLoneSurrogates(value: unknown): LoneSurrogateRepair {
  let repaired = 0;

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      // Fast path: no lone surrogate, so hand back the identical string.
      if (!LONE_SURROGATE.test(node)) return node;
      return node.replace(LONE_SURROGATE_ALL, () => {
        repaired++;
        return REPLACEMENT;
      });
    }

    if (Array.isArray(node)) {
      let changed = false;
      const next = node.map((item) => {
        const walked = walk(item);
        if (walked !== item) changed = true;
        return walked;
      });
      return changed ? next : node;
    }

    if (isPlainObject(node)) {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) {
        // Keys are repaired too: an object key is as unencodable as a value.
        const walkedKey = walk(key) as string;
        const walkedItem = walk(item);
        if (walkedKey !== key || walkedItem !== item) changed = true;
        next[walkedKey] = walkedItem;
      }
      return changed ? next : node;
    }

    return node;
  };

  const walked = walk(value);
  return { value: walked, repaired };
}

/**
 * Plain data holders only — an object literal or a null-prototype object, the
 * shapes `JSON.parse` produces. Anything carrying a real prototype is a class
 * instance and is left alone.
 */
function isPlainObject(node: unknown): node is Record<string, unknown> {
  if (typeof node !== "object" || node === null) return false;
  const proto = Object.getPrototypeOf(node);
  return proto === Object.prototype || proto === null;
}
