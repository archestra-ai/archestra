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

/**
 * Stands in for an assistant turn whose entire text output was inline
 * `<thinking>` and stripped to nothing, so a user-facing surface (A2A reply,
 * reconstructed transcript) carries an explanation rather than a blank message.
 */
export const THINKING_ONLY_NOTICE =
  "The agent produced only internal reasoning and no visible response.";
