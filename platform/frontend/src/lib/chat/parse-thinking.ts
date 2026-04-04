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
 */
export function hasThinkingTags(text: string): boolean {
  return /<think>/i.test(text);
}
