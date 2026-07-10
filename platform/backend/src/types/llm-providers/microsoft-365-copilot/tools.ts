/**
 * Microsoft 365 Copilot tool schemas - OpenAI-compatible inbound wire format, so
 * we re-export OpenAI schemas. Note the provider itself rejects requests that
 * declare tools (the Graph Chat API has no tool calling); these schemas exist
 * so declared tools can be parsed and refused with a clear error.
 */
export {
  FunctionDefinitionParametersSchema,
  ToolChoiceOptionSchema,
  ToolSchema,
} from "../openai/tools";
