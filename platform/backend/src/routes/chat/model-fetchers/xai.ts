import type { SupportedProvider } from "@archestra/shared";
import config from "@/config";
import { decodeXaiSubscriptionCredential } from "@/services/xai-subscription-credentials";
import { xaiSubscriptionTokenManager } from "@/services/xai-subscription-token";
import type { OpenAi } from "@/types";
import { joinBaseUrl } from "@/utils/base-url";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { ModelInfo } from "./types";

type XaiRawModel = OpenAi.Types.Model | OpenAi.Types.OrlandoModel;

function mapXaiModel(
  model: XaiRawModel,
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

/**
 * Lists xAI models for either credential shape.
 *
 * With an "X Premium (SuperGrok)" subscription credential the stored secret is
 * an encoded OAuth credential rather than a bearer token, so it is first
 * redeemed for a short-lived access token. Unlike the ChatGPT/Codex equivalent
 * there is no maintained model list to fall back on: xAI serves subscription
 * traffic on its ordinary OpenAI-compatible surface, `/models` included, so the
 * catalog stays live and reflects whatever the account is actually entitled to.
 */
export async function fetchXaiModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.xai.baseUrl;

  let bearer = apiKey;
  const subscriptionCredential = decodeXaiSubscriptionCredential(apiKey);
  if (subscriptionCredential) {
    // Throws (401) when the refresh token is rejected, so key creation surfaces
    // a real "reconnect your X account" error instead of an empty list.
    bearer = await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: subscriptionCredential.refreshToken,
    });
  }

  const data = await fetchModelsWithBearerAuth<{ data: XaiRawModel[] }>({
    url: joinBaseUrl(baseUrl, "/models"),
    apiKey: bearer,
    errorLabel: "xAI models",
    extraHeaders,
  });

  return data.data.map((model) => mapXaiModel(model, "xai"));
}
