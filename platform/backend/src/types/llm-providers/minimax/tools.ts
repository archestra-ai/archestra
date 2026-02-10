/**
 * MiniMax tool schemas - OpenAI-compatible
 *
 * MiniMax uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://console.minimax.com/docs/api-reference#chat-create
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
