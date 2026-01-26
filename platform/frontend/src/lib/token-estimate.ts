import type { UIMessage } from "@ai-sdk/react";
import { useMemo } from "react";

/**
 * Rough estimate of tokens from text.
 * Uses the common heuristic of ~4 characters per token for English text.
 * This is a rough approximation - actual token counts vary by model tokenizer.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~4 characters per token is a reasonable estimate for English text
  // This tends to slightly overestimate, which is safer for context limits
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total tokens from a message.
 * Includes all text parts and a rough estimate for tool calls.
 */
export function estimateMessageTokens(message: UIMessage): number {
  let tokens = 0;

  // Role overhead (roughly 4 tokens for role markers)
  tokens += 4;

  for (const part of message.parts) {
    if (part.type === "text" && "text" in part) {
      tokens += estimateTokens(part.text);
    } else if (part.type === "tool-invocation" || part.type === "tool-result") {
      // Tool calls have JSON overhead - estimate from stringified content
      try {
        const json = JSON.stringify(part);
        tokens += estimateTokens(json);
      } catch {
        tokens += 50; // Fallback estimate for tool parts
      }
    } else if (part.type === "reasoning" && "reasoning" in part) {
      tokens += estimateTokens(String(part.reasoning));
    }
  }

  return tokens;
}

/**
 * Estimate total tokens used across all messages in a conversation.
 */
export function estimateTotalTokens(messages: UIMessage[]): number {
  return messages.reduce((total, msg) => total + estimateMessageTokens(msg), 0);
}

/**
 * Hook to estimate token usage for a conversation.
 * Returns the estimated token count and memoizes the calculation.
 */
export function useTokenEstimate(messages: UIMessage[]): number {
  return useMemo(() => estimateTotalTokens(messages), [messages]);
}
