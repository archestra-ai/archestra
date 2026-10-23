/** Format only JSON whitespace: preserve large numbers, duplicate keys and escapes. */
export function formatJsonPreview(source: string): string | null {
  try {
    JSON.parse(source);
  } catch {
    return null;
  }
  const tokens =
    source.match(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g) ?? [];
  let depth = 0;
  let result = "";
  const newline = () => `\n${"  ".repeat(depth)}`;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const previous = tokens[i - 1];
    if (token === "{" || token === "[") {
      result += token;
      depth++;
      if (tokens[i + 1] !== "}" && tokens[i + 1] !== "]") result += newline();
    } else if (token === "}" || token === "]") {
      depth--;
      if (previous !== "{" && previous !== "[") result += newline();
      result += token;
    } else if (token === ",") {
      result += token + newline();
    } else if (token === ":") {
      result += ": ";
    } else {
      result += token;
    }
  }
  return result;
}
