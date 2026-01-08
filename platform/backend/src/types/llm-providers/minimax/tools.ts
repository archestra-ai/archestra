/**
 * MiniMax uses OpenAI-compatible tool/function calling format.
 * Re-export OpenAI tool schemas for consistency.
 */
export {
  FunctionDefinitionParametersSchema,
  ToolSchema,
  ToolChoiceOptionSchema,
} from "../openai/tools";
