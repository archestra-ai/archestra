import { LRUCacheManager } from "@/cache-manager";
import type {
  Anthropic,
  Cohere,
  DeepSeek,
  Gemini,
  Groq,
  Minimax,
  Ollama,
  OpenAi,
  Openrouter,
  Vllm,
  Zhipuai,
} from "@/types";

export type ProviderMessage =
  | OpenAi.Types.ChatCompletionsRequest["messages"][number]
  | Anthropic.Types.MessagesRequest["messages"][number]
  | Cohere.Types.ChatRequest["messages"][number]
  | Gemini.Types.GenerateContentRequest["contents"][number]
  | Groq.Types.ChatCompletionsRequest["messages"][number]
  | Openrouter.Types.ChatCompletionsRequest["messages"][number]
  | Vllm.Types.ChatCompletionsRequest["messages"][number]
  | Ollama.Types.ChatCompletionsRequest["messages"][number]
  | Zhipuai.Types.ChatCompletionsRequest["messages"][number]
  | DeepSeek.Types.ChatCompletionsRequest["messages"][number]
  | Minimax.Types.ChatCompletionsRequest["messages"][number];

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

// The same conversation history is re-sent on every agentic turn, so counting
// tokens naively re-encodes the entire history each turn — synchronous,
// CPU-heavy work that scales with conversation length. Per-message counts are
// memoized by content instead, so a repeated message is an O(1) cache hit
// rather than a re-encode. The cache lives on the (process-wide, shared)
// tokenizer instance, so it survives across requests.
const TOKEN_COUNT_CACHE_MAX_ENTRIES = 10_000;

/**
 * Abstract base class for tokenizers.
 * These tokenizers are approximate.
 * E.g. they are used to estimate token count before sending an LLM request.
 *
 * To get exact token count for stats and costs, see token usage in LLM response.
 */
export abstract class BaseTokenizer implements Tokenizer {
  private readonly tokenCountCache = new LRUCacheManager<number>({
    maxSize: TOKEN_COUNT_CACHE_MAX_ENTRIES,
    // Token counts are a pure function of the input, so they never go stale.
    // Disable the manager's default (1h) TTL and rely solely on LRU eviction —
    // otherwise a long-running conversation re-encodes every message once an
    // hour, the exact cost this memo exists to avoid.
    defaultTtl: 0,
  });

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

  countMessageTokens(message: ProviderMessage): number {
    const encodableText = this.getEncodableText(message);
    // Key by content length + a cheap hash. Counts are approximate, so the
    // negligible collision chance of a compact key is an acceptable trade for
    // keeping the cache small; the length prefix makes a false hit vanishingly
    // unlikely.
    const cacheKey = `${encodableText.length}:${fnv1a32(encodableText)}`;

    const cached = this.tokenCountCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const count = this.computeMessageTokens(encodableText);
    this.tokenCountCache.set(cacheKey, count);
    return count;
  }

  /**
   * Count tokens in one message's already-assembled encodable text. The default
   * is a rough chars/4 approximation; provider tokenizers override this with
   * their real encoder. Callers should use {@link countMessageTokens} (which
   * memoizes); this method does the uncached work.
   */
  protected computeMessageTokens(encodableText: string): number {
    return Math.ceil(encodableText.length / 4);
  }

  /** Build the text a tokenizer encodes for a message: its role plus its text. */
  private getEncodableText(message: ProviderMessage): string {
    const role = "role" in message && message.role ? message.role : "";
    return `${role}${this.getMessageText(message)}`;
  }

  /**
   * Extract text content from a message, which can be a string or a collection of objects
   */
  protected getMessageText(message: ProviderMessage): string {
    // OpenAI/Anthropic format: content property
    if ("content" in message) {
      if (typeof message.content === "string") {
        return message.content;
      }

      if (Array.isArray(message.content)) {
        const text = message.content.reduce(
          (acc: string, block: { type?: string; text?: string }) => {
            if (block.type === "text" && typeof block.text === "string") {
              acc += block.text;
            }
            return acc;
          },
          "",
        );

        return text;
      }
    }

    // Gemini format: parts property
    if ("parts" in message && Array.isArray(message.parts)) {
      let text = "";
      for (const part of message.parts) {
        if ("text" in part && typeof part.text === "string") {
          text += part.text;
        }
        // Handle function call/response by serializing args/response
        if (
          "functionCall" in part &&
          part.functionCall &&
          typeof part.functionCall === "object"
        ) {
          const fc = part.functionCall as { name?: string; args?: unknown };
          text += `function_call:${fc.name || "unknown"}(${JSON.stringify(fc.args || {})})`;
        }
        if (
          "functionResponse" in part &&
          part.functionResponse &&
          typeof part.functionResponse === "object"
        ) {
          const fr = part.functionResponse as {
            name?: string;
            response?: unknown;
          };
          text += `function_response:${fr.name || "unknown"}(${JSON.stringify(fr.response || {})})`;
        }
      }
      return text;
    }

    return "";
  }
}

/**
 * FNV-1a (32-bit) — a cheap, non-cryptographic hash used only to derive compact
 * cache keys for the per-message token-count memo. It is far cheaper than
 * running the tokenizer, so hashing to look up a cached count beats re-encoding.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
