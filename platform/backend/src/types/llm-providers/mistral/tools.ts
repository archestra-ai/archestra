/**
 * Mistral tool schemas - OpenAI-compatible
 *
 * Mistral uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://docs.mistral.ai/api
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
