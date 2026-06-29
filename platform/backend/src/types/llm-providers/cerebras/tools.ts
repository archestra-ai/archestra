/**
 * Cerebras tool schemas - OpenAI-compatible
 *
 * Cerebras uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://inference-docs.cerebras.ai/
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
