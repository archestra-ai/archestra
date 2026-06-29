/**
 * DeepSeek message schemas - OpenAI-compatible
 *
 * DeepSeek uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://api-docs.deepseek.com/api/create-chat-completion
 */
export { MessageParamSchema, ToolCallSchema } from "../openai/messages";
