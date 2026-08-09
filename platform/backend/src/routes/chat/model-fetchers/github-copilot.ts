import type { SupportedProviderEndpoint } from "@archestra/shared";
import config from "@/config";
import logger from "@/logging";
import { createGithubCopilotFetch } from "@/services/github-copilot-token";
import { ApiError, GithubCopilot } from "@/types";
import { joinBaseUrl } from "@/utils/base-url";
import { type ModelInfo, modelFetchError } from "./types";

/**
 * Fetches the models available to the Copilot subscription behind the given
 * GitHub OAuth token. `apiKey` is the GitHub token; the Copilot fetch wrapper
 * exchanges it for the short-lived bearer the /models endpoint requires.
 *
 * The proxy speaks both of Copilot's generative surfaces — `/chat/completions`
 * and `/responses` — so a model is catalogued when it is reachable through
 * either, and the surface it needs is recorded on it (see `supportedEndpoints`
 * in FetchedModelCapabilities) because nothing in a Copilot model id reveals
 * which one it is. Everything else `/models` returns is dropped: the Anthropic
 * `/v1/messages` shim, embeddings, and `completion` models. We do NOT filter on
 * `model_picker_enabled`: on some plans the only picker-enabled model is a
 * Responses-only one, while every usable chat model is picker=false, so that
 * flag would surface an unusable model and hide the working ones (verified
 * against a live subscription).
 *
 * The catalog fields alone are not enough: `/models` also lists entries the
 * declared endpoint rejects outright with `model_not_supported` — retired
 * aliases next to their still-working snapshots (`gpt-4` vs `gpt-4o`,
 * `gpt-3.5-turbo` vs `gpt-3.5-turbo-0613`), client-internal agent models
 * (`copilot-search-*`, `exec-agent-*`), and per-plan-unavailable models that
 * still declare a supported endpoint. No field discriminates them (verified
 * live: a dead alias can be field-identical to a working model, down to
 * `version`), so every candidate is verified with a zero-inference probe
 * against the endpoint it claims before it is catalogued.
 */
export async function fetchGithubCopilotModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm["github-copilot"].baseUrl;
  const copilotFetch = createGithubCopilotFetch({ githubToken: apiKey });

  const response = await copilotFetch(joinBaseUrl(baseUrl, "/models"), {
    headers: { ...(extraHeaders ?? {}) },
  });
  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText.slice(0, 500) },
      "Failed to fetch GitHub Copilot models",
    );
    // The Copilot fetch wrapper reports token-exchange failures as an
    // OpenAI-shaped error Response; surface its curated message (e.g. "no
    // Copilot subscription") so key validation shows the real cause.
    if (response.status === 401) {
      throw new ApiError(401, extractErrorMessage(errorText));
    }
    throw modelFetchError("GitHub Copilot models", response.status);
  }

  const payload = (await response.json()) as {
    data?: GithubCopilotModel[];
  };

  const candidates = (Array.isArray(payload.data) ? payload.data : []).filter(
    isInvocableModel,
  );
  const invocable = await dropModelsRejectedUpstream({
    candidates,
    copilotFetch,
    baseUrl,
    extraHeaders,
  });

  return invocable.map((model) => ({
    id: model.id,
    displayName: model.name || model.id,
    provider: "github-copilot" as const,
    capabilities: {
      contextLength:
        model.capabilities?.limits?.max_context_window_tokens ?? null,
      supportsToolCalling: model.capabilities?.supports?.tool_calls ?? null,
      supportedEndpoints: servableEndpoints(model),
    },
  }));
}

// ===== Internal helpers =====

/** Concurrent invocability probes per sync (a catalog is a few dozen entries). */
const VERIFY_CONCURRENCY = 8;

const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions" as const;

/**
 * The Copilot surfaces the proxy speaks, in the order a model is preferred to
 * be served over. Chat completions first: a model offering both is served over
 * the surface with the broader feature coverage in the proxy, and the Responses
 * surface is reserved for the models that have no alternative.
 */
const PROXY_SERVABLE_ENDPOINTS: readonly SupportedProviderEndpoint[] = [
  CHAT_COMPLETIONS_ENDPOINT,
  "/responses",
];

/**
 * Drops candidates Copilot would reject with `model_not_supported`, using a
 * deliberately invalid, zero-inference request against the endpoint each model
 * declares: CAPI validates the model before the payload, so a dead model
 * answers `model_not_supported` while a live one answers with a payload
 * complaint — "messages must be non-empty" on chat completions, a missing
 * `input` on responses (verified live). No tokens are generated and no model is
 * ever invoked, so the probe cannot consume a premium request.
 *
 * Only a definite `model_not_supported` drops a model. Anything inconclusive
 * (429, 5xx, network failure — or a validation-order change upstream) keeps
 * it, so an outage degrades to an unverified catalog instead of an empty one.
 */
async function dropModelsRejectedUpstream(params: {
  candidates: GithubCopilotModel[];
  copilotFetch: ReturnType<typeof createGithubCopilotFetch>;
  baseUrl: string;
  extraHeaders?: Record<string, string> | null;
}): Promise<GithubCopilotModel[]> {
  const { candidates, copilotFetch, baseUrl, extraHeaders } = params;
  if (candidates.length === 0) {
    return candidates;
  }

  const invocable: boolean[] = new Array(candidates.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(VERIFY_CONCURRENCY, candidates.length) },
    async () => {
      while (nextIndex < candidates.length) {
        const index = nextIndex;
        nextIndex += 1;
        invocable[index] = await isModelInvocable({
          modelId: candidates[index].id,
          // Probe the surface the model actually claims; probing a
          // Responses-only model on chat completions would read as
          // model_not_supported and drop every GPT-5.x model.
          endpoint: servableEndpoints(candidates[index])[0],
          copilotFetch,
          baseUrl,
          extraHeaders,
        });
      }
    },
  );
  await Promise.all(workers);

  const dropped = candidates.filter((_, index) => !invocable[index]);
  if (dropped.length > 0) {
    logger.info(
      { droppedModelIds: dropped.map((model) => model.id) },
      "Dropped GitHub Copilot models the chat/completions endpoint rejects",
    );
  }
  return candidates.filter((_, index) => invocable[index]);
}

async function isModelInvocable(params: {
  modelId: string;
  endpoint: SupportedProviderEndpoint;
  copilotFetch: ReturnType<typeof createGithubCopilotFetch>;
  baseUrl: string;
  extraHeaders?: Record<string, string> | null;
}): Promise<boolean> {
  const { modelId, endpoint, copilotFetch, baseUrl, extraHeaders } = params;
  try {
    const response = await copilotFetch(joinBaseUrl(baseUrl, endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(extraHeaders ?? {}),
      },
      // Invalid on purpose: the model is validated before the payload, so
      // this never generates output — see dropModelsRejectedUpstream. Chat
      // completions gets an empty `messages`; responses gets no `input` at
      // all, since an empty `input` array is a valid Responses request and
      // would actually invoke the model.
      body: JSON.stringify(
        endpoint === CHAT_COMPLETIONS_ENDPOINT
          ? { model: modelId, messages: [] }
          : { model: modelId },
      ),
    });
    if (response.ok) {
      await response.body?.cancel();
      return true;
    }
    const errorText = await response.text();
    try {
      const parsed = JSON.parse(errorText) as { error?: { code?: string } };
      return parsed.error?.code !== GithubCopilot.API.MODEL_NOT_SUPPORTED_CODE;
    } catch {
      return true;
    }
  } catch {
    // Network failure is inconclusive — keep the model.
    return true;
  }
}

/**
 * The endpoints the proxy can serve this model over, in preference order.
 * Copilot omits `supported_endpoints` on legacy chat models, which do support
 * chat completions — so an absent field means chat completions, not "unknown".
 */
function servableEndpoints(
  model: GithubCopilotModel,
): SupportedProviderEndpoint[] {
  const declared = model.supported_endpoints;
  if (!Array.isArray(declared)) {
    return [CHAT_COMPLETIONS_ENDPOINT];
  }
  return PROXY_SERVABLE_ENDPOINTS.filter((endpoint) =>
    declared.includes(endpoint),
  );
}

/** True if the model is reachable through either surface the proxy speaks. */
function isInvocableModel(model: GithubCopilotModel): boolean {
  if (model.policy?.state === "disabled") return false;
  // Only chat models work here — exclude embeddings and `completion` models.
  if (model.capabilities?.type && model.capabilities.type !== "chat") {
    return false;
  }
  // Drops the surfaces the proxy does not speak (e.g. the Anthropic
  // `/v1/messages` shim), which would 400 on both of ours.
  return servableEndpoints(model).length > 0;
}

function extractErrorMessage(errorText: string): string {
  try {
    const parsed = JSON.parse(errorText) as { error?: { message?: string } };
    if (parsed.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // not JSON — fall through to the generic message
  }
  return "GitHub token was rejected by the Copilot API";
}

interface GithubCopilotModel {
  id: string;
  name?: string;
  /** Transports the model supports, e.g. ["/chat/completions"], ["/responses"]. */
  supported_endpoints?: string[];
  policy?: { state?: string };
  capabilities?: {
    /** "chat" | "embeddings" | "completion" — only "chat" is usable here. */
    type?: string;
    limits?: { max_context_window_tokens?: number };
    supports?: { tool_calls?: boolean };
  };
}
