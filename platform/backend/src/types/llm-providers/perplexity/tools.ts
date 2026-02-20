/**
 * Perplexity tool schemas
 *
 * Note: Perplexity does NOT support external tool calling.
 * It performs internal web searches and returns results in the search_results field.
 *
 * These schemas are exported for type compatibility but should not be used
 * for actual tool invocation with Perplexity.
 *
 * @see https://docs.perplexity.ai/api-reference/chat-completions-post
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
