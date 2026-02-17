/**
 * Perplexity tool schemas - OpenAI-compatible
 *
 * Perplexity uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://docs.perplexity.ai/api-reference
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
