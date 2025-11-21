import type { Anthropic, OpenAi } from "@/types";

/**
 * Message types from different providers
 */
export type ProviderMessage =
  | OpenAi.Types.ChatCompletionsRequest["messages"][number]
  | Anthropic.Types.MessagesRequest["messages"][number];

/**
 * Base interface for tokenizers
 * Provides a unified way to count tokens across different providers
 */
export interface Tokenizer {
  /**
   * Count tokens in a single message
   */
  countMessageTokens(message: ProviderMessage): number;

  /**
   * Count tokens in an array of messages
   */
  countMessagesTokens(messages: ProviderMessage[]): number;
}

/**
 * Abstract base class for tokenizers
 * Provides default implementation for counting multiple messages
 */
export abstract class BaseTokenizer implements Tokenizer {
  abstract countMessageTokens(message: ProviderMessage): number;

  countMessagesTokens(messages: ProviderMessage[]): number {
    let totalTokens = 0;
    for (const message of messages) {
      totalTokens += this.countMessageTokens(message);
    }
    return totalTokens;
  }

  /**
   * Extract text content from a message
   * Handles both string and array content formats
   */
  protected extractTextFromMessage(message: ProviderMessage): string {
    let text = "";

    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
        }
      }
    }

    return text;
  }
}
