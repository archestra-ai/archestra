/**
 * Strip `<thinking>...</thinking>` blocks from LLM responses.
 * These are internal reasoning blocks that should not be shown to users.
 *
 * Uses non-greedy matching (`*?`) so multiple separate thinking blocks are
 * stripped independently without eating content between them. This assumes
 * blocks are not nested — nested `<thinking>` tags would leave the tail
 * visible, but LLMs do not produce nested thinking blocks in practice.
 */
export function stripThinkingBlocks(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}
