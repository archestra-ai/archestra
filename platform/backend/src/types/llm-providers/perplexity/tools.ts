/**
 * Perplexity tool schemas
 *
 * Note: the chat-completions endpoint these schemas accompany accepts no tools.
 * It performs internal web searches and returns results in the search_results field.
 *
 * These schemas are exported for type compatibility but should not be used for
 * actual tool invocation with Perplexity. They would not fit the surface that
 * does take tools either: the Agent API declares functions flat
 * (`{ type: "function", name, parameters }`), not nested under `function` the
 * way chat-completions does (see inferPerplexityCapabilities in
 * services/model-sync.ts).
 *
 * @see https://docs.perplexity.ai/api-reference/chat-completions-post
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
