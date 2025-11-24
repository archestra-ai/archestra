import type { Anthropic, OpenAi } from "@/types";

export type ProviderMessage =
  | OpenAi.Types.ChatCompletionsRequest["messages"][number]
  | Anthropic.Types.MessagesRequest["messages"][number];

/**
 * Base interface for tokenizers
 * Provides a unified way to count tokens across different providers
 */
export interface Tokenizer {
  /**
   * Count tokens in messages (array or single message)
   */
  countTokens(messages: ProviderMessage[] | ProviderMessage): number;
}

/**
 * Abstract base class for tokenizers.
 * These tokenizers are approximate.
 * E.g. they are used to estimate token count before sending an LLM request.
 *
 * To get exact token count for stats and costs, see token usage in LLM response.
 */
export abstract class BaseTokenizer implements Tokenizer {
  countMessageTokens(message: ProviderMessage): number {
    const text = this.getMessageText(message);
    return Math.ceil(text.length / 4);
  }

  countTokens(messages: ProviderMessage[] | ProviderMessage): number {
    if (Array.isArray(messages)) {
      const total = messages.reduce((sum, message) => {
        return sum + this.countMessageTokens(message);
      }, 0);
      return total;
    } else {
      return this.countMessageTokens(messages);
    }
  }

  /**
   * Extract text content from a message, which can be a string or a collection of objects
   */
  protected getMessageText(message: ProviderMessage): string {
    if (typeof message.content === "string") {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      const text = message.content.reduce((text, block) => {
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
        }
        return text;
      }, "");

      return text;
    }

    return "";
  }
}
