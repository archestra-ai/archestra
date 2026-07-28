/**
 * Tool-call arguments and tool outputs arrive as provider-supplied strings that
 * are only *expected* to be JSON. Truncated streams and models that emit invalid
 * JSON both reach the interaction log verbatim, so parsing has to be total:
 * returning the raw string keeps the log viewer rendering instead of throwing.
 */
export function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
