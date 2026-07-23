/**
 * Parse <think>...</think> tags from text content (used by Qwen and similar models)
 * Returns an array of parts that can be rendered as text or reasoning blocks
 */

export type ParsedThinkingPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string };

/**
 * Parse text content that may contain <think>...</think> tags
 * Used by Qwen models that embed reasoning in think tags
 *
 * @param text - The text content that may contain think tags
 * @returns Array of parsed parts (text and reasoning)
 */
export function parseThinkingTags(text: string): ParsedThinkingPart[] {
  const parts: ParsedThinkingPart[] = [];

  // An unpaired leading </think> means the model was prefilled with the opening
  // tag (Ollama does this to suppress thinking) and reasoned anyway, so the
  // opening tag never appears in the output. Everything before the stray closer
  // is reasoning; everything after is the answer. Without this, the reasoning
  // renders as the assistant's message.
  const orphanClose = matchOrphanClosingTag(text);
  if (orphanClose) {
    return orphanClose;
  }

  // Regex to match <think>...</think> blocks (case-insensitive, non-greedy, handles newlines)
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // biome-ignore lint/suspicious/noAssignInExpressions: Standard regex exec pattern
  while ((match = thinkRegex.exec(text)) !== null) {
    // Add any text before this think block
    if (match.index > lastIndex) {
      const beforeText = text.slice(lastIndex, match.index).trim();
      if (beforeText) {
        parts.push({ type: "text", text: beforeText });
      }
    }

    // Add the thinking content
    const thinkingContent = match[1].trim();
    if (thinkingContent) {
      parts.push({ type: "reasoning", text: thinkingContent });
    }

    lastIndex = match.index + match[0].length;
  }

  // Add any remaining text after the last think block
  if (lastIndex < text.length) {
    const afterText = text.slice(lastIndex).trim();
    if (afterText) {
      parts.push({ type: "text", text: afterText });
    }
  }

  // If no think tags were found, return original text as single part
  if (parts.length === 0 && text.trim()) {
    return [{ type: "text", text: text.trim() }];
  }

  return parts;
}

/**
 * Check if text contains think tags
 *
 * Matches a stray closing tag too: Ollama prefills the opening `<think>` when
 * asked to suppress thinking, so a model that reasons anyway emits only the
 * closer. Testing for `<think>` alone would let that whole block render as the
 * assistant's answer.
 */
export function hasThinkingTags(text: string): boolean {
  return /<\/?think>/i.test(text);
}

/**
 * Splits text whose reasoning is terminated by a `</think>` that has no opening
 * tag before it. Returns null when the text is not that shape, so the normal
 * paired-tag parser runs.
 */
function matchOrphanClosingTag(text: string): ParsedThinkingPart[] | null {
  const close = text.search(/<\/think>/i);
  if (close === -1) return null;

  // A properly paired block anywhere in the text means the model emitted its
  // own tags, so the main parser owns the whole message. Only the prefilled
  // shape — a closer with no matching opener at all — is handled here.
  // Checking just "is there an opener before the first closer" reclassified
  // everything ahead of a merely-quoted `</think>` as reasoning, and left the
  // real paired block after it rendering as literal text.
  //
  // This also subsumes the "opener before the first closer" case: an opener at
  // i < close means [i, close] is itself a paired block.
  if (/<think>[\s\S]*?<\/think>/i.test(text)) return null;

  // Beyond that, the closer has to look emitted rather than discussed. A model
  // explaining think tags is plausible in this product's own domain, and a
  // closer quoted inside a fence would otherwise tear the fence across two
  // rendered parts.
  if (!isPrefilledClosingTag(text, close)) return null;

  const parts: ParsedThinkingPart[] = [];
  const reasoning = text.slice(0, close).trim();
  if (reasoning) {
    parts.push({ type: "reasoning", text: reasoning });
  }
  const answer = text
    .slice(close)
    .replace(/^<\/think>/i, "")
    .trim();
  if (answer) {
    parts.push({ type: "text", text: answer });
  }
  // A bare `</think>` with nothing either side yields no parts. Returning an
  // empty array here would short-circuit the caller — `[]` is truthy — and the
  // message would render as nothing at all, message actions included. Hand it
  // back to the main parser, which falls through to plain text.
  return parts.length > 0 ? parts : null;
}

/**
 * Whether the `</think>` at `index` is Ollama's prefilled-opener artifact
 * rather than a closer the model merely wrote about.
 *
 * Deliberately narrow. A closer that genuinely terminates prefilled reasoning
 * often sits mid-line (`weighing the options</think>Here is the answer`), so
 * position alone cannot separate the two — only signals that a closer is being
 * *discussed* are safe to act on:
 *
 * - more than one closer: prose about the tag, not one emitted turn
 * - inside a fence or inline code span: quoted, and splitting there would tear
 *   the fence across two rendered parts
 *
 * Plain prose that mentions `</think>` exactly once outside any code stays
 * ambiguous and is still treated as prefilled. That is the intended trade:
 * Ollama's prefill is common and silently renders reasoning as the answer,
 * while a bare single mention is rare and merely renders oddly.
 */
function isPrefilledClosingTag(text: string, index: number): boolean {
  const closers = text.match(/<\/think>/gi);
  if (closers && closers.length > 1) return false;

  const before = text.slice(0, index);
  const fencesBefore = (before.match(/```/g) ?? []).length;
  if (fencesBefore % 2 === 1) return false;
  const backticksBefore = (before.match(/`/g) ?? []).length;
  return backticksBefore % 2 === 0;
}
