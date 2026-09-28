import { randomUUID } from "node:crypto";
import { ArchestraInternalErrorCode } from "@archestra/shared";
import { z } from "zod";
import config from "@/config";
import { decodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { createOpenAiCodexFetch } from "@/services/openai-codex-token";
import { ApiError, type OpenAi } from "@/types";
import { joinBaseUrl } from "@/utils/base-url";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import {
  type ModelFetchOptions,
  type ModelInfo,
  modelFetchError,
} from "./types";

// Codex uses client_version to gate models that require a newer client.
// Use a verified Codex CLI version until release tracking is automated.
const CODEX_MODELS_CLIENT_VERSION = "0.158.0";

const CodexModelsResponseSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      display_name: z.string().optional(),
      visibility: z.enum(["list", "hide", "none"]),
      priority: z.number(),
    }),
  ),
});

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
  opts?: ModelFetchOptions,
): Promise<ModelInfo[]> {
  // ChatGPT subscription credentials use the account's Codex model catalog.
  const codexCredential = decodeOpenAiCodexCredential(apiKey);
  if (codexCredential) {
    // The wrapper redeems and rotates the OAuth token, then retries one 401.
    // Passing the key row id preserves a rotated refresh token during sync.
    const codexFetch = createOpenAiCodexFetch({
      credential: codexCredential,
      providerApiKeyId: opts?.providerApiKeyId,
      sessionId: randomUUID(),
    });
    const url = joinBaseUrl(
      config.llm.openai.codex.apiBaseUrl,
      `/models?client_version=${CODEX_MODELS_CLIENT_VERSION}`,
    );
    const response = await codexFetch(url, { redirect: "error" });
    if (response.status === 401) {
      throw new ApiError(
        401,
        "ChatGPT sign-in has expired or been revoked. Reconnect your ChatGPT account to keep using your Codex subscription.",
        ArchestraInternalErrorCode.ProviderAuthRequired,
      );
    }
    if (!response.ok) {
      throw modelFetchError("OpenAI Codex models", response.status);
    }

    const { models } = CodexModelsResponseSchema.parse(await response.json());
    return models
      .filter((model) => model.visibility === "list")
      .sort((a, b) => a.priority - b.priority)
      .map((model) => ({
        id: model.slug,
        displayName: model.display_name || model.slug,
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
