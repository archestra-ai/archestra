import { createHash } from "node:crypto";
import { credentialRequiresPerUserScope } from "@archestra/shared";
import config from "@/config";
import {
  fetchLiteLlmOutputLimits,
  readOutputTokenLimit,
} from "@/routes/chat/model-fetchers/litellm";
import { PLACEHOLDER_API_KEY } from "@/routes/chat/model-fetchers/types";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import type { LlmProviderApiKey } from "@/types";
import { joinBaseUrl } from "@/utils/base-url";

const CACHE_TTL_MS = 5 * 60_000;
const UNKNOWN_TTL_MS = 30_000;
const MAX_CONNECTIONS = 500;
const cache = new Map<
  string,
  {
    fingerprint: string;
    expiresAt: number;
    limits: Promise<Map<string, number | null>>;
  }
>();

/** Refreshes invalidate this process's cache; other replicas recheck on expiry. */
export function invalidateGatewayOutputLimits(apiKeyId: string): void {
  cache.delete(apiKeyId);
}

/**
 * Stable releases cannot add a migration after main's unbackported migrations.
 * Resolve endpoint-local metadata lazily instead, including after cold starts.
 * Cache only limits, never the credential, and coalesce simultaneous lookups.
 */
export async function resolveGatewayOutputLimit(
  key: LlmProviderApiKey,
  modelId: string,
): Promise<number | null> {
  if (key.provider !== "openai") return null;
  const baseUrl = key.baseUrl || config.llm.openai.baseUrl;
  try {
    if (new URL(baseUrl).origin === "https://api.openai.com") return null;
  } catch {
    return null;
  }
  // A reconnect or endpoint/header edit must not reuse the previous cap.
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([key.updatedAt, baseUrl, key.secretId, key.extraHeaders]),
    )
    .digest("hex");
  let entry = cache.get(key.id);
  if (
    !entry ||
    entry.fingerprint !== fingerprint ||
    entry.expiresAt <= Date.now()
  ) {
    if (cache.size >= MAX_CONNECTIONS)
      cache.delete(cache.keys().next().value as string);
    const next = {
      fingerprint,
      expiresAt: Date.now() + CACHE_TTL_MS,
      limits: loadLimits(key, baseUrl),
    };
    cache.set(key.id, next);
    entry = next;
    // Missing/restricted metadata is ordinary, but should recover promptly.
    void next.limits.then((limits) => {
      next.expiresAt =
        Date.now() +
        ([...limits.values()].some((limit) => typeof limit === "number")
          ? CACHE_TTL_MS
          : UNKNOWN_TTL_MS);
    });
  }
  return (await entry.limits).get(modelId) ?? null;
}

async function loadLimits(
  key: LlmProviderApiKey,
  baseUrl: string,
): Promise<Map<string, number | null>> {
  try {
    const apiKey = key.secretId
      ? await getSecretValueForLlmProviderApiKey(key.secretId)
      : PLACEHOLDER_API_KEY;
    if (
      !apiKey ||
      credentialRequiresPerUserScope({ provider: key.provider, apiKey })
    )
      return new Map();
    const [listed, detailed] = await Promise.all([
      fetchListedLimits({ baseUrl, apiKey, extraHeaders: key.extraHeaders }),
      fetchLiteLlmOutputLimits({
        baseUrl,
        apiKey,
        extraHeaders: key.extraHeaders,
      }),
    ]);
    for (const [modelId, cap] of detailed) {
      if (cap !== null)
        listed.set(modelId, Math.min(listed.get(modelId) ?? cap, cap));
    }
    return listed;
  } catch {
    // Optional metadata must not turn a generation into an authentication or
    // network failure, or leak response bodies/provider configuration.
    return new Map();
  }
}

async function fetchListedLimits(params: {
  baseUrl: string;
  apiKey: string;
  extraHeaders: Record<string, string> | null;
}): Promise<Map<string, number | null>> {
  const limits = new Map<string, number | null>();
  try {
    const response = await fetch(joinBaseUrl(params.baseUrl, "/models"), {
      headers: {
        ...params.extraHeaders,
        Authorization: `Bearer ${params.apiKey}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return limits;
    const body = await response.json();
    if (!Array.isArray(body?.data)) return limits;
    for (const model of body.data) {
      if (typeof model?.id !== "string") continue;
      const cap = readOutputTokenLimit(model.max_output_tokens);
      if (cap !== undefined)
        limits.set(model.id, Math.min(limits.get(model.id) ?? cap, cap));
    }
  } catch {
    // A gateway can expose /model/info while /models is unavailable.
  }
  return limits;
}
