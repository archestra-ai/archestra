/**
 * xAI (Grok) tool schemas - OpenAI-compatible
 *
 * xAI uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://docs.x.ai/docs/api-reference
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
