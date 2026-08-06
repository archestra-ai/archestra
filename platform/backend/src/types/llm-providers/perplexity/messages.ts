/**
 * Perplexity message schemas - OpenAI-compatible
 *
 * Perplexity uses an OpenAI-compatible API for messages.
 * Note: no tool-call or tool-result messages arise here — the chat-completions
 * endpoint takes no tools (see inferPerplexityCapabilities in
 * services/model-sync.ts).
 *
 * @see https://docs.perplexity.ai/api-reference/chat-completions-post
 */
export { MessageParamSchema } from "../openai/messages";
