import config from "@/config";
import { VOYAGE_EMBEDDING_MODELS } from "@/knowledge-base/embedding-clients/voyage-models";
import logger from "@/logging";
import { joinBaseUrl } from "@/utils/base-url";
import type { ModelInfo } from "./types";
import { modelFetchError } from "./types";

/**
 * Voyage AI publishes NO model-listing endpoint, so the catalog is the KB's own
 * static capability table (`voyage-models.ts`) — the same table the embedding
 * client drives, so the two can never disagree about what is offered or at what
 * dimension.
 *
 * Voyage is embeddings-only: every model here is tagged with
 * `embeddingDimensions`, which is what keeps them out of chat model pickers
 * (those filter on it) without any Voyage-specific gate.
 *
 * With no listing to call, an invalid key would otherwise sail through key
 * creation and only fail later at ingestion time, unlike every other provider
 * whose `/models` request 401s immediately. A single one-token embed stands in
 * for that: an auth rejection fails the fetch the same way a 401 from a listing
 * would, while any other failure (rate limit, provider outage) still yields the
 * catalog rather than blocking a perfectly good key.
 */
export async function fetchVoyageModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  await assertKeyAccepted(apiKey, baseUrlOverride, extraHeaders);

  return VOYAGE_EMBEDDING_MODELS.map((entry) => ({
    id: entry.modelId,
    displayName: entry.displayName,
    provider: "voyage" as const,
    capabilities: {
      embeddingDimensions: entry.dimensions,
      contextLength: entry.contextTokens,
    },
  }));
}

// ===== Internal helpers =====

async function assertKeyAccepted(
  apiKey: string,
  baseUrlOverride: string | null | undefined,
  extraHeaders: Record<string, string> | null | undefined,
): Promise<void> {
  const baseUrl = baseUrlOverride || config.llm.voyage.baseUrl;
  const url = joinBaseUrl(baseUrl.replace(/\/v1$/, ""), "/v1/embeddings");

  let status: number;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(extraHeaders || {}),
      },
      // The cheapest possible request that still exercises the credential.
      body: JSON.stringify({
        model: VOYAGE_KEY_PROBE_MODEL,
        input: ["archestra"],
        input_type: "document",
        truncation: true,
      }),
    });
    status = response.status;
  } catch (error) {
    // A network-level failure says nothing about the key — serve the catalog.
    logger.warn(
      { err: error },
      "[VoyageModels] Key probe failed at the network level; serving the static catalog",
    );
    return;
  }

  if (status === 401 || status === 403) {
    throw modelFetchError("Voyage models", status);
  }
  if (status >= 400) {
    logger.warn(
      { status },
      "[VoyageModels] Key probe returned a non-auth error; serving the static catalog",
    );
  }
}

// ===== Internal constants =====

/**
 * Probed with the cheapest model in the catalog. Voyage keys are account-wide
 * rather than model-scoped, so any valid key is accepted here.
 */
const VOYAGE_KEY_PROBE_MODEL = "voyage-3.5-lite";
