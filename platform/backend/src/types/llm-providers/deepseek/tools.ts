/**
 * DeepSeek tool schemas - OpenAI-compatible
 *
 * DeepSeek uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://console.deepseek.com/docs/api-reference#chat-create
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
