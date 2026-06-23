import type { SupportedProvider } from "@archestra/shared";
import { MINIMAX_MODELS, PERPLEXITY_MODELS } from "@archestra/shared";
import type { OpenAi } from "@/types";
import { fetchAnthropicModels } from "./anthropic";
import { fetchAzureModels } from "./azure";
import { makeBearerFetcher, makeStaticFetcher } from "./bearer-fetcher";
import { fetchBedrockModels } from "./bedrock";
import { fetchCohereModels } from "./cohere";
import { fetchDeepSeekModels } from "./deepseek";
import { fetchGeminiModels } from "./gemini";
import { fetchGithubCopilotModels } from "./github-copilot";
import { fetchOllamaModels } from "./ollama";
import { fetchOpenAiModels } from "./openai";
import { fetchOpenrouterModels } from "./openrouter";
import type { ModelFetcher, ModelInfo } from "./types";
import { fetchVllmModels } from "./vllm";

function mapOpenAiCompatibleOptionalCreated(
  model: OpenAi.Types.Model | OpenAi.Types.OrlandoModel,
  provider: SupportedProvider,
): ModelInfo {
  return {
    id: model.id,
    displayName: model.id,
    provider,
    createdAt:
      "created" in model && typeof model.created === "number"
        ? new Date(model.created * 1000).toISOString()
        : undefined,
  };
}

const ZHIPUAI_CHAT_PREFIXES = ["glm-", "chatglm-"];
const ZHIPUAI_EXCLUDE_PATTERNS = ["-embedding"];

function zhipuaiFilter(id: string): boolean {
  const lower = id.toLowerCase();
  if (!ZHIPUAI_CHAT_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return false;
  }
  return !ZHIPUAI_EXCLUDE_PATTERNS.some((pattern) => lower.includes(pattern));
}

function prependZhipuaiFreeModel(models: ModelInfo[]): ModelInfo[] {
  const freeModels: ModelInfo[] = [
    {
      id: "glm-4.5-flash",
      displayName: "glm-4.5-flash",
      provider: "zhipuai",
      createdAt: new Date().toISOString(),
    },
  ];

  const existingIds = new Set(models.map((model) => model.id.toLowerCase()));
  const result: ModelInfo[] = [];

  for (const freeModel of freeModels) {
    if (!existingIds.has(freeModel.id.toLowerCase())) {
      result.push(freeModel);
    }
  }

  result.push(...models);

  return result;
}

const fetchCerebrasModels = makeBearerFetcher({
  provider: "cerebras",
  configKey: "cerebras",
  errorLabel: "Cerebras models",
  filter: (id) => !id.toLowerCase().includes("llama"),
});

const fetchGroqModels = makeBearerFetcher({
  provider: "groq",
  configKey: "groq",
  errorLabel: "Groq models",
});

const fetchMistralModels = makeBearerFetcher({
  provider: "mistral",
  configKey: "mistral",
  errorLabel: "Mistral models",
});

const fetchXaiModels = makeBearerFetcher<
  OpenAi.Types.Model | OpenAi.Types.OrlandoModel
>({
  provider: "xai",
  configKey: "xai",
  errorLabel: "xAI models",
  mapModel: mapOpenAiCompatibleOptionalCreated,
});

const fetchZhipuaiModels = makeBearerFetcher({
  provider: "zhipuai",
  configKey: "zhipuai",
  errorLabel: "Zhipuai models",
  filter: zhipuaiFilter,
  postProcess: prependZhipuaiFreeModel,
});

export const modelFetchers: Record<SupportedProvider, ModelFetcher> = {
  anthropic: fetchAnthropicModels,
  azure: fetchAzureModels,
  bedrock: fetchBedrockModels,
  cerebras: fetchCerebrasModels,
  cohere: fetchCohereModels,
  deepseek: fetchDeepSeekModels,
  gemini: fetchGeminiModels,
  "github-copilot": fetchGithubCopilotModels,
  groq: fetchGroqModels,
  minimax: makeStaticFetcher("minimax", MINIMAX_MODELS),
  mistral: fetchMistralModels,
  ollama: fetchOllamaModels,
  openai: fetchOpenAiModels,
  openrouter: fetchOpenrouterModels,
  perplexity: makeStaticFetcher("perplexity", PERPLEXITY_MODELS),
  vllm: fetchVllmModels,
  xai: fetchXaiModels,
  zhipuai: fetchZhipuaiModels,
};
