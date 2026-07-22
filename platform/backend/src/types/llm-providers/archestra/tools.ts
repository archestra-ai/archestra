/**
 * Archestra tool schemas - OpenAI-compatible
 *
 * The Archestra proxy speaks an OpenAI-compatible API, so we re-export OpenAI
 * schemas.
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
