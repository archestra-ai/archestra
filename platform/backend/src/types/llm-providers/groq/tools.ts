/**
 * Groq tool schemas - OpenAI-compatible
 *
 * Groq uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://console.groq.com/docs/api-reference
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
