/**
 * MiniMax tool schemas - OpenAI-compatible
 *
 * MiniMax uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://platform.minimaxi.com/document/ChatCompletion%20v2
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
