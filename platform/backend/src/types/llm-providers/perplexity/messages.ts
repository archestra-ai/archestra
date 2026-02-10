/**
 * Perplexity message schemas - OpenAI-compatible
 *
 * Perplexity uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://console.perplexity.com/docs/api-reference#chat-create
 */
export { MessageParamSchema, ToolCallSchema } from "../openai/messages";
