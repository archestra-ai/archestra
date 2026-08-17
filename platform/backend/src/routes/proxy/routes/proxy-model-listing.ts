import {
  hasArchestraTokenPrefix,
  type SupportedProvider,
  stripClaudeContextVariantSuffix,
} from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { LlmProviderApiKeyModel, ModelModel } from "@/models";
import type { ModelInfo } from "@/routes/chat/model-fetchers/types";
import { assertSubscriptionCredentialForProvider } from "@/services/subscription-credential-guard";
import { ApiError } from "@/types";
import {
  validateVirtualApiKey,
  virtualKeyRateLimiter,
} from "../llm-proxy-auth";

export const AnthropicModelsHeadersSchema = z.object({
  "x-api-key": z.string().optional(),
  authorization: z.string().optional(),
  "anthropic-version": z.string().optional(),
});

export const OpenAiModelsHeadersSchema = z.object({
  authorization: z.string().optional(),
});

export const AnthropicModelsListResponseSchema = z.object({
  data: z.array(
    z.object({
      type: z.literal("model"),
      id: z.string(),
      display_name: z.string(),
      created_at: z.string().optional(),
    }),
  ),
  has_more: z.boolean(),
});

export const OpenAiModelsListResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(
    z.object({
      id: z.string(),
      object: z.literal("model"),
      created: z.number(),
      owned_by: z.string(),
    }),
  ),
});

export interface ResolvedProxyModelsKey {
  apiKey: string;
  baseUrl: string | undefined;
  extraHeaders: Record<string, string> | null;
}

/**
 * Resolve the upstream provider key for a `GET /models` request: an `arch_*`
 * virtual key is validated (rate limited per IP) and swapped for its mapped
 * provider key; any other token is used as a raw provider key.
 */
export async function resolveProxyModelsApiKey(params: {
  request: Pick<FastifyRequest, "ip">;
  provider: SupportedProvider;
  token: string | undefined;
}): Promise<ResolvedProxyModelsKey> {
  const { request, provider, token } = params;

  if (!token) {
    throw new ApiError(
      401,
      `Authentication required. Provide an API key for ${provider}.`,
    );
  }

  // Raw keys carry no per-key extra headers, matching the inference path's
  // raw-bearer branch (no parent provider-key row to read them from).
  if (!hasArchestraTokenPrefix(token)) {
    assertSubscriptionCredentialForProvider({ apiKey: token, provider });
    return { apiKey: token, baseUrl: undefined, extraHeaders: null };
  }

  await virtualKeyRateLimiter.check({ ip: request.ip, credential: token });
  try {
    const resolved = await validateVirtualApiKey(token, provider);
    if (!resolved.apiKey) {
      throw new ApiError(401, `Could not resolve an API key for ${provider}.`);
    }
    assertSubscriptionCredentialForProvider({
      apiKey: resolved.apiKey,
      provider,
    });
    // Per-key extra headers (e.g. gateway RBAC headers) live on the parent
    // provider key, applied here the same way the inference path applies them.
    const providerKey = resolved.chatApiKeyId
      ? await LlmProviderApiKeyModel.findById(resolved.chatApiKeyId)
      : null;
    // Model discovery targets the provider's canonical base URL, not the
    // inference override: `resolved.baseUrl` is coalesce(inferenceBaseUrl,
    // baseUrl), and a custom inference gateway may not serve `/models`. Fall
    // back to the provider default (undefined) when no base is configured.
    return {
      apiKey: resolved.apiKey,
      baseUrl: providerKey?.baseUrl ?? undefined,
      extraHeaders: providerKey?.extraHeaders ?? null,
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) {
      // Best-effort: a failure to record must never mask the underlying 401.
      await virtualKeyRateLimiter
        .recordFailure({ ip: request.ip, credential: token })
        .catch(() => {});
    }
    throw error;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The window size the `[1m]` context-variant marker names. */
const ONE_MILLION_TOKEN_CONTEXT = 1_000_000;

export function extractBearerToken(
  authorization: string | string[] | undefined,
): string | undefined {
  return headerValue(authorization)?.match(/^Bearer\s+(.+)$/i)?.[1];
}

/**
 * Token for an Anthropic-style request: `x-api-key` takes precedence (what the
 * Anthropic SDK and Archestra's own model fetcher send), falling back to a
 * Bearer token.
 */
export function extractAnthropicToken(headers: {
  "x-api-key"?: string | string[];
  authorization?: string | string[];
}): string | undefined {
  return (
    headerValue(headers["x-api-key"]) ??
    extractBearerToken(headers.authorization)
  );
}

/**
 * Interleave a `[1m]` long-context sibling after each Claude model whose
 * catalog row records a 1M-token window.
 *
 * Anthropic's own `/v1/models` never lists the bracketed variant ids — the
 * marker is a client convention — but Claude Code populates its model picker
 * from this endpoint when gateway model discovery is enabled, keeping only the
 * ids the gateway returns. Passing the upstream list through unchanged
 * therefore made a Claude Code configured with e.g. `claude-opus-5[1m]`
 * switch to the base id — and the 200K window it assumes behind a gateway —
 * the first time it connected. A model the catalog records no 1M window for
 * gets no sibling, so nothing is advertised that the model may not serve.
 */
export async function appendClaudeContextVariants(
  models: ModelInfo[],
): Promise<ModelInfo[]> {
  const variantCandidates = models.filter(
    (model) =>
      /claude/i.test(model.id) &&
      stripClaudeContextVariantSuffix(model.id) === model.id,
  );
  if (variantCandidates.length === 0) {
    return models;
  }

  const catalogRows = await ModelModel.findByProviderModelIds(
    variantCandidates.map((model) => ({
      provider: "anthropic" as const,
      modelId: model.id,
    })),
  );
  const listedIds = new Set(models.map((model) => model.id));

  const withVariants: ModelInfo[] = [];
  for (const model of models) {
    withVariants.push(model);
    const variantId = `${model.id}[1m]`;
    const contextLength = catalogRows.get(
      `anthropic:${model.id}`,
    )?.contextLength;
    if (
      contextLength != null &&
      contextLength >= ONE_MILLION_TOKEN_CONTEXT &&
      !listedIds.has(variantId)
    ) {
      withVariants.push({
        ...model,
        id: variantId,
        displayName: `${model.displayName} (1M context)`,
      });
    }
  }
  return withVariants;
}

export function toAnthropicModelsList(models: ModelInfo[]) {
  return {
    data: models.map((model) => ({
      type: "model" as const,
      id: model.id,
      // ModelInfo types displayName as required, but rows built from
      // non-Anthropic-shaped upstream listings can leave it undefined at
      // runtime — the response schema requires a string, so a single bare
      // row used to fail the whole listing with a serialization 500.
      display_name: model.displayName ?? model.id,
      created_at: model.createdAt,
    })),
    has_more: false,
  };
}

/**
 * `ownedBy` is the provider actually serving the models. It used to be
 * hardcoded to "openai" — right on the OpenAI route by coincidence, wrong on
 * the GitHub Copilot and Microsoft 365 Copilot routes, and contradicting the
 * model router, which reports `owned_by: <provider>` for the same models.
 */
export function toOpenAiModelsList(
  models: ModelInfo[],
  ownedBy: SupportedProvider,
) {
  return {
    object: "list" as const,
    data: models.map((model) => ({
      id: model.id,
      object: "model" as const,
      created: model.createdAt
        ? Math.floor(new Date(model.createdAt).getTime() / 1000)
        : 0,
      owned_by: ownedBy,
    })),
  };
}
