/**
 * The name a pool goes by for a provider's model id. Providers that resell
 * other vendors' models prefix them: Bedrock with a vendor and, for
 * cross-region inference profiles, a region (`us.zai.glm-5.3`), plus a version
 * suffix (`-v1:0`); OpenRouter with a vendor path (`z-ai/glm-4.6`). The name
 * drops those, so one model reads the same whichever key lists it.
 */
export function poolModelName(provider: string, modelId: string): string {
  if (provider === "bedrock") {
    return modelId
      .replace(BEDROCK_REGION_PREFIX, "")
      .replace(/^[a-z0-9-]+\./, "")
      .replace(/-v\d+(:\d+)?$/, "");
  }
  if (provider === "openrouter") return modelId.replace(/^[^/]+\//, "");
  return modelId;
}

/**
 * The id a key most likely serves the pool's `name` under: the name itself,
 * else an id whose pool name is `name`, the shortest first (`zai.glm-5` before
 * `us.zai.glm-5`). Falls back to the name.
 */
export function suggestModelId(
  name: string,
  provider: string | undefined,
  keyModels: string[] = [],
): string {
  if (!name || !provider || keyModels.includes(name)) return name;
  const matching = keyModels
    .filter((modelId) => poolModelName(provider, modelId) === name)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return matching[0] ?? name;
}

/** Whether a model can answer a chat request, so it can be pooled. */
export function isPoolableModel(model: {
  modelId: string;
  embeddingDimensions: number | null;
  ignored: boolean;
}): boolean {
  return (
    !model.ignored &&
    model.embeddingDimensions === null &&
    !/embed/i.test(model.modelId)
  );
}

// Bedrock's cross-region inference profile prefixes.
const BEDROCK_REGION_PREFIX = /^(global|us|us-gov|eu|apac|jp|au|ca)\./;
