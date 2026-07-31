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
 * Our proxy adapter only speaks `/chat/completions`, so we list every model
 * reachable that way and drop the rest. Copilot's `/models` also returns
 * Responses-API-only models (e.g. `gpt-5.3-codex`, `supported_endpoints:
 * ["/responses"]`), the Anthropic `/v1/messages` shim, embeddings, and
 * `completion` models — all of which 400 on `/chat/completions`. We do NOT
 * filter on `model_picker_enabled`: on some plans the only picker-enabled
 * model is a Responses-only one, while every usable chat model is
 * picker=false, so that flag would surface an unusable model and hide the
 * working ones (verified against a live subscription).
 *
 * The catalog fields alone are not enough: `/models` also lists entries that
 * `/chat/completions` rejects outright with `model_not_supported` — retired
 * aliases next to their still-working snapshots (`gpt-4` vs `gpt-4o`,
 * `gpt-3.5-turbo` vs `gpt-3.5-turbo-0613`), client-internal agent models
 * (`copilot-search-*`, `exec-agent-*`), and per-plan-unavailable models that
 * still declare `"/chat/completions"` in `supported_endpoints`. No field
 * discriminates them (verified live: a dead alias can be field-identical to a
 * working model, down to `version`), so every candidate is verified with a
 * zero-inference probe before it is catalogued.
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
    isChatCompletionsModel,
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
    },
  }));
}

// ===== Internal helpers =====

/** Concurrent invocability probes per sync (a catalog is a few dozen entries). */
const VERIFY_CONCURRENCY = 8;

/**
 * Drops candidates Copilot's `/chat/completions` would reject with
 * `model_not_supported`, using a deliberately invalid, zero-inference request:
 * CAPI validates the model before the payload, so a dead model answers
 * `model_not_supported` while a live one answers "messages must be non-empty"
 * (verified live). No tokens are generated and no model is ever invoked, so
 * the probe cannot consume a premium request.
 *
 * Only a definite `model_not_supported` drops a model. Anything inconclusive
 * (429, 5xx, network failure — or a validation-order change upstream) keeps
 * it, so an outage degrades to today's unverified catalog instead of an empty
 * one.
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
  copilotFetch: ReturnType<typeof createGithubCopilotFetch>;
  baseUrl: string;
  extraHeaders?: Record<string, string> | null;
}): Promise<boolean> {
  const { modelId, copilotFetch, baseUrl, extraHeaders } = params;
  try {
    const response = await copilotFetch(
      joinBaseUrl(baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(extraHeaders ?? {}),
        },
        // Invalid on purpose: the model is validated before the payload, so
        // this never generates output — see dropModelsRejectedUpstream.
        body: JSON.stringify({ model: modelId, messages: [] }),
      },
    );
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

/** True if the model is usable through Copilot's `/chat/completions` endpoint. */
function isChatCompletionsModel(model: GithubCopilotModel): boolean {
  if (model.policy?.state === "disabled") return false;
  // Only chat models work here — exclude embeddings and `completion` models.
  if (model.capabilities?.type && model.capabilities.type !== "chat") {
    return false;
  }
  // When Copilot states the supported transports, require chat/completions.
  // (The field is often absent on legacy chat models, which do support it.)
  const endpoints = model.supported_endpoints;
  if (Array.isArray(endpoints) && !endpoints.includes("/chat/completions")) {
    return false;
  }
  return true;
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
