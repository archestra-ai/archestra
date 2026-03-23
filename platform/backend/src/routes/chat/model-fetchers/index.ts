import type { SupportedProvider } from "@shared";
import { fetchAnthropicModels } from "./anthropic";
import { fetchBedrockModels } from "./bedrock";
import { fetchCerebrasModels } from "./cerebras";
import { fetchCohereModels } from "./cohere";
import { fetchDeepSeekModels } from "./deepseek";
import { fetchGeminiModels } from "./gemini";
import { fetchGroqModels } from "./groq";
import { fetchMinimaxModels } from "./minimax";
import { fetchMistralModels } from "./mistral";
import { fetchOllamaModels } from "./ollama";
import { fetchOpenAiModels } from "./openai";
import { fetchOpenrouterModels } from "./openrouter";
import { fetchPerplexityModels } from "./perplexity";
import type { ModelFetcher } from "./types";
import { fetchVllmModels } from "./vllm";
import { fetchXaiModels } from "./xai";
import { fetchZhipuaiModels } from "./zhipuai";

export const modelFetchers: Record<SupportedProvider, ModelFetcher> = {
  anthropic: fetchAnthropicModels,
  bedrock: fetchBedrockModels,
  cerebras: fetchCerebrasModels,
  cohere: fetchCohereModels,
  deepseek: fetchDeepSeekModels,
  gemini: fetchGeminiModels,
  groq: fetchGroqModels,
  minimax: fetchMinimaxModels,
  mistral: fetchMistralModels,
  ollama: fetchOllamaModels,
  openai: fetchOpenAiModels,
  openrouter: fetchOpenrouterModels,
  perplexity: fetchPerplexityModels,
  vllm: fetchVllmModels,
  xai: fetchXaiModels,
  zhipuai: fetchZhipuaiModels,
};
