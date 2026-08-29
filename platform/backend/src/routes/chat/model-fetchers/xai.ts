import {
  ArchestraInternalErrorCode,
  SUBSCRIPTION_CREDENTIALS,
  type SupportedProvider,
  subscriptionKindFromCredential,
} from "@archestra/shared";
import config from "@/config";
import { decodeXaiSubscriptionCredential } from "@/services/xai-subscription-credentials";
import {
  xaiSubscriptionSessionHeaders,
  xaiSubscriptionTokenManager,
} from "@/services/xai-subscription-token";
import { ApiError, type OpenAi } from "@/types";
import { joinBaseUrl } from "@/utils/base-url";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { ModelFetchOptions, ModelInfo } from "./types";

type XaiRawModel =
  | OpenAi.Types.Model
  | OpenAi.Types.OrlandoModel
  | {
      id?: unknown;
      model?: unknown;
      modelId?: unknown;
      name?: unknown;
      created?: unknown;
      apiBackend?: unknown;
      api_backend?: unknown;
      baseUrl?: unknown;
      base_url?: unknown;
      hidden?: unknown;
      supportedInApi?: unknown;
      supported_in_api?: unknown;
      _meta?: {
        model?: unknown;
        modelId?: unknown;
        hidden?: unknown;
        supportedInApi?: unknown;
      };
    };

function mapXaiModel(
  model: XaiRawModel,
  provider: SupportedProvider,
  isSubscription: boolean,
  inferenceBaseUrl: string,
): ModelInfo | null {
  // The subscription proxy separates its catalog id from the model slug sent
  // on the wire. It also publishes models for multiple protocols, while
  // Archestra's xAI adapter currently implements chat completions only. Mirror
  // xAI's first-party precedence and fail closed on entries we cannot invoke.
  //
  // The subscription CLI proxy (cli-chat-proxy.grok.com) serves its models over
  // the OpenAI-compatible /chat/completions endpoint our adapter uses even when
  // a model advertises a different native backend — e.g. grok-4.5 reports
  // `api_backend: "responses"` yet answers chat completions. So on the
  // subscription path `responses` is invocable; the metered API is still held to
  // chat_completions only, since that translation is unverified there.
  const apiBackend =
    "apiBackend" in model || "api_backend" in model
      ? (model.apiBackend ?? model.api_backend)
      : undefined;
  const backendIsInvocable =
    typeof apiBackend !== "string" ||
    apiBackend === "chat_completions" ||
    (isSubscription && apiBackend === "responses");
  const modelBaseUrl =
    "baseUrl" in model || "base_url" in model
      ? (model.baseUrl ?? model.base_url)
      : undefined;
  const hidden =
    ("hidden" in model && model.hidden === true) ||
    ("_meta" in model && model._meta?.hidden === true);
  const supportedInApi =
    "supportedInApi" in model || "supported_in_api" in model || "_meta" in model
      ? (model.supportedInApi ??
        model.supported_in_api ??
        model._meta?.supportedInApi)
      : undefined;
  if (
    hidden ||
    // xAI defines supportedInApi=false as OAuth-only: session users should see
    // it, while public API-key users should not.
    (supportedInApi === false && !isSubscription) ||
    !backendIsInvocable ||
    (typeof modelBaseUrl === "string" &&
      modelBaseUrl.replace(/\/+$/, "") !== inferenceBaseUrl.replace(/\/+$/, ""))
  ) {
    return null;
  }
  const candidateIds = [
    "model" in model ? model.model : undefined,
    "modelId" in model ? model.modelId : undefined,
    model.id,
    "_meta" in model ? model._meta?.model : undefined,
    "_meta" in model ? model._meta?.modelId : undefined,
  ];
  const id = candidateIds.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0,
  );
  if (!id) {
    return null;
  }
  const displayName =
    "name" in model && typeof model.name === "string" && model.name
      ? model.name
      : id;
  return {
    id,
    displayName,
    provider,
    createdAt:
      "created" in model && typeof model.created === "number"
        ? new Date(model.created * 1000).toISOString()
        : undefined,
    capabilities: { supportedEndpoints: ["/chat/completions"] },
  };
}

/**
 * Lists xAI models for either credential shape.
 *
 * With an "SuperGrok" subscription credential the stored secret is
 * an encoded OAuth credential rather than a bearer token, so it is first
 * redeemed for a short-lived access token and sent to xAI's dedicated session
 * proxy with the required account/client headers. Plain API keys continue to
 * use the configured metered API endpoint.
 */
export async function fetchXaiModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
  opts?: ModelFetchOptions,
): Promise<ModelInfo[]> {
  let baseUrl = baseUrlOverride || config.llm.xai.baseUrl;
  let bearer = apiKey;
  let requestHeaders = extraHeaders;
  const subscriptionKind = subscriptionKindFromCredential(apiKey);
  if (
    subscriptionKind &&
    SUBSCRIPTION_CREDENTIALS[subscriptionKind].provider !== "xai"
  ) {
    throw new ApiError(
      401,
      "The selected xAI key contains a subscription credential for another provider. Reconnect the correct credential.",
      ArchestraInternalErrorCode.ProviderAuthRequired,
    );
  }
  const subscriptionCredential = decodeXaiSubscriptionCredential(apiKey);
  if (subscriptionKind === "x-premium" && !subscriptionCredential) {
    throw new ApiError(
      401,
      "Your xAI SuperSuperGrok sign-in is unreadable. Reconnect your Grok account to continue.",
      ArchestraInternalErrorCode.ProviderAuthRequired,
    );
  }
  if (subscriptionCredential) {
    // A per-key override describes an API-key endpoint, never the first-party
    // subscription proxy. Reject it instead of silently sending OAuth material
    // to a user-supplied origin.
    if (baseUrlOverride) {
      throw new ApiError(
        400,
        "SuperGrok credentials cannot use a per-key base URL override — remove it or use an API key instead.",
      );
    }
    baseUrl = config.llm.xai.subscription.baseUrl;
    // Throws (401) when the refresh token is rejected, so key creation surfaces
    // a real "reconnect your Grok account" error instead of an empty list.
    // The row id (when the key already exists) lets the manager persist a
    // rotated refresh token instead of discarding it — the issuer invalidates
    // the predecessor, so a discarded rotation leaves the stored token dead.
    bearer = await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: subscriptionCredential.refreshToken,
      providerApiKeyId: opts?.providerApiKeyId,
    });
    requestHeaders = {
      ...(extraHeaders ?? {}),
      ...xaiSubscriptionSessionHeaders(subscriptionCredential),
    };
  }

  const data = await fetchModelsWithBearerAuth<{ data: XaiRawModel[] }>({
    url: joinBaseUrl(baseUrl, "/models"),
    apiKey: bearer,
    errorLabel: "xAI models",
    extraHeaders: requestHeaders,
    redirect: subscriptionCredential ? "manual" : undefined,
  });

  return data.data.flatMap((model) => {
    const mapped = mapXaiModel(
      model,
      "xai",
      subscriptionCredential !== null,
      baseUrl,
    );
    return mapped ? [mapped] : [];
  });
}
