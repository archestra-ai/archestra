/**
 * Model context window sizes (in tokens)
 * This maps model identifiers to their maximum context window size
 *
 * Note: Ollama models get their context window dynamically from the Ollama API.
 * This file only contains cloud provider models that don't provide dynamic context info.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI Models
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4o-2024-08-06': 128000,
  'gpt-4o-2024-05-13': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4-turbo-preview': 128000,
  'gpt-4-0125-preview': 128000,
  'gpt-4-1106-preview': 128000,
  'gpt-4': 8192,
  'gpt-4-0613': 8192,
  'gpt-3.5-turbo': 16385,
  'gpt-3.5-turbo-16k': 16385,
  'gpt-3.5-turbo-0125': 16385,
  'gpt-3.5-turbo-1106': 16385,
  'o1-preview': 128000,
  'o1-mini': 128000,

  // Anthropic Claude Models
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-sonnet': 200000,
  'claude-3-opus-20240229': 200000,
  'claude-3-opus': 200000,
  'claude-3-sonnet-20240229': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-haiku-20240307': 200000,
  'claude-3-haiku': 200000,
  'claude-2.1': 200000,
  'claude-2': 100000,
  'claude-instant-1.2': 100000,

  // Google Gemini Models
  'gemini-1.5-pro': 2097152, // 2M context
  'gemini-1.5-pro-latest': 2097152,
  'gemini-1.5-flash': 1048576, // 1M context
  'gemini-2.5-flash': 1048576, // 1M context
  'gemini-1.5-flash-latest': 1048576,
  'gemini-pro': 32768,
  'gemini-pro-vision': 32768,

  // DeepSeek Models
  'deepseek-chat': 128000,
  'deepseek-coder': 128000,
  'deepseek-reasoner': 128000,

  // Archestra LLM (uses Gemini Flash)
  'archestra-llm': 1048576, // 1M context (same as gemini-2.5-flash)

  // Default fallback for unknown models
  default: 128000,
};

/**
 * Get the context window size for a given model
 * @param model The model identifier
 * @returns The context window size in tokens
 */
export function getModelContextWindow(model: string): number {
  // Try exact match first
  if (MODEL_CONTEXT_WINDOWS[model]) {
    return MODEL_CONTEXT_WINDOWS[model];
  }

  // Try to match base model name (e.g., "llama3.1:8b-instruct-q4_0" -> "llama3.1:8b")
  const baseModel = model.split('-')[0];
  if (MODEL_CONTEXT_WINDOWS[baseModel]) {
    return MODEL_CONTEXT_WINDOWS[baseModel];
  }

  // Try without size suffix (e.g., "llama3.1:8b" -> "llama3.1")
  const modelWithoutSize = model.split(':')[0];
  if (MODEL_CONTEXT_WINDOWS[modelWithoutSize]) {
    return MODEL_CONTEXT_WINDOWS[modelWithoutSize];
  }

  // Return default if no match found
  return MODEL_CONTEXT_WINDOWS.default;
}
