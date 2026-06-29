import config from "@/config";
import logger from "@/logging";
import { createGithubCopilotFetch } from "@/services/github-copilot-token";
import { ApiError } from "@/types";
import { joinBaseUrl } from "@/utils/base-url";
import type { ModelInfo } from "./types";

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
    throw new Error(
      `Failed to fetch GitHub Copilot models: ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    data?: GithubCopilotModel[];
  };

  return (Array.isArray(payload.data) ? payload.data : [])
    .filter(isChatCompletionsModel)
    .map((model) => ({
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
