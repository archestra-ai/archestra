import {
  hasArchestraTokenPrefix,
  type SupportedProvider,
} from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { LlmProviderApiKeyModel } from "@/models";
import type { ModelInfo } from "@/routes/chat/model-fetchers/types";
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
    return { apiKey: token, baseUrl: undefined, extraHeaders: null };
  }

  await virtualKeyRateLimiter.check(request.ip);
  try {
    const resolved = await validateVirtualApiKey(token, provider);
    if (!resolved.apiKey) {
      throw new ApiError(401, `Could not resolve an API key for ${provider}.`);
    }
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
      await virtualKeyRateLimiter.recordFailure(request.ip).catch(() => {});
    }
    throw error;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

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

export function toAnthropicModelsList(models: ModelInfo[]) {
  return {
    data: models.map((model) => ({
      type: "model" as const,
      id: model.id,
      display_name: model.displayName,
      created_at: model.createdAt,
    })),
    has_more: false,
  };
}

export function toOpenAiModelsList(models: ModelInfo[]) {
  return {
    object: "list" as const,
    data: models.map((model) => ({
      id: model.id,
      object: "model" as const,
      created: model.createdAt
        ? Math.floor(new Date(model.createdAt).getTime() / 1000)
        : 0,
      owned_by: "openai",
    })),
  };
}
