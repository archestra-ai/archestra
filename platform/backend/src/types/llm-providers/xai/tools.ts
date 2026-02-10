/**
 * XAI tool schemas - OpenAI-compatible
 *
 * XAI uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://console.xai.com/docs/api-reference#chat-create
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
