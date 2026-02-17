/**
 * Groq message schemas - OpenAI-compatible
 *
 * Groq uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://console.groq.com/docs/api-reference#chat-create
 */
export { MessageParamSchema, ToolCallSchema } from "../openai/messages";
