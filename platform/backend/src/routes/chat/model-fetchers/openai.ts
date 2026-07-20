import config from "@/config";
import {
  decodeOpenAiCodexCredential,
  OPENAI_CODEX_MODELS,
} from "@/services/openai-codex-credentials";
import { openAiCodexTokenManager } from "@/services/openai-codex-token";
import type { OpenAi } from "@/types";
import { joinBaseUrl } from "@/utils/base-url";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { ModelInfo } from "./types";

export function mapOpenAiModelToModelInfo(
  model: OpenAi.Types.Model | OpenAi.Types.OrlandoModel,
): ModelInfo {
  let provider: ModelInfo["provider"] = "openai";

  if (!("owned_by" in model)) {
    if (model.id.startsWith("claude-")) {
      provider = "anthropic";
    } else if (model.id.startsWith("gemini-")) {
      provider = "gemini";
    }
  }

  return {
    id: model.id,
    displayName: "name" in model ? model.name : model.id,
    provider,
    createdAt:
      "created" in model
        ? new Date(model.created * 1000).toISOString()
        : undefined,
  };
}

// babbage/davinci are OpenAI's legacy completions-only base models: they 404 on
// /chat/completions ("not a chat model"). They, and the other non-chat families,
// are dropped so they never enter the selectable chat catalog.
const NON_CHAT_MODEL_ID_PATTERNS = [
  "instruct",
  "tts",
  "whisper",
  "image",
  "audio",
  "sora",
  "dall-e",
  "babbage",
  "davinci",
];

/** @public — exported for unit tests; the chat-catalog filter fetchOpenAiModels applies. */
export function isChatModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT_MODEL_ID_PATTERNS.some((pattern) => lower.includes(pattern));
}

export async function fetchOpenAiModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  // "ChatGPT subscription" (Codex) auth mode: the credential is an encoded
  // ChatGPT OAuth credential, and the Codex backend exposes no /models endpoint.
  // Validate the credential by redeeming an access token, then return the
  // maintained Codex model list.
  const codexCredential = decodeOpenAiCodexCredential(apiKey);
  if (codexCredential) {
    // Throws (401) when the refresh token is rejected, so key creation surfaces
    // a real "reconnect your ChatGPT account" error instead of an empty list.
    await openAiCodexTokenManager.getAccessToken({
      refreshToken: codexCredential.refreshToken,
    });
    return OPENAI_CODEX_MODELS.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      provider: "openai" as const,
    }));
  }

  const baseUrl = baseUrlOverride || config.llm.openai.baseUrl;
  const data = await fetchModelsWithBearerAuth<{
    data: (OpenAi.Types.Model | OpenAi.Types.OrlandoModel)[];
  }>({
    url: joinBaseUrl(baseUrl, "/models"),
    apiKey,
    errorLabel: "OpenAI models",
    extraHeaders,
  });

  return data.data
    .filter((model) => isChatModelId(model.id))
    .map(mapOpenAiModelToModelInfo);
}
