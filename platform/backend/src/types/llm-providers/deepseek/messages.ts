/**
 * DeepSeek message schemas - OpenAI-compatible
 *
 * DeepSeek uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://console.deepseek.com/docs/api-reference#chat-create
 */
export { MessageParamSchema, ToolCallSchema } from "../openai/messages";
