/**
 * x.ai (Grok) tool schemas - OpenAI-compatible
 *
 * x.ai uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://docs.x.ai/api
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
