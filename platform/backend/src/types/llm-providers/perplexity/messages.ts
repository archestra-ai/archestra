/**
 * Perplexity message schemas - OpenAI-compatible
 *
 * Perplexity uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://docs.perplexity.ai/api-reference/chat-completions-post
 */
export { MessageParamSchema, ToolCallSchema } from "../openai/messages";
