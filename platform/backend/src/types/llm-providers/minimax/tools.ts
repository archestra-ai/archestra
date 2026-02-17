/**
 * MiniMax tool schemas - OpenAI-compatible
 *
 * MiniMax uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
