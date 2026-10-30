import { z } from "zod";
import { joinBaseUrl } from "@/utils/base-url";

/** Optional LiteLLM metadata; an OpenAI-compatible server need not implement it. */
export async function fetchLiteLlmOutputLimits(params: {
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string> | null;
}): Promise<Map<string, number | null>> {
  const outputLimits = new Map<string, number | null>();
  if (new URL(params.baseUrl).origin === "https://api.openai.com")
    return outputLimits;
  try {
    const response = await fetch(joinBaseUrl(params.baseUrl, "/model/info"), {
      headers: {
        ...params.extraHeaders,
        Authorization: `Bearer ${params.apiKey}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    // Metadata access can be restricted even when /models and inference work.
    // Never log its body: it can contain provider configuration and secrets.
    if (!response.ok) return outputLimits;
    const parsed = ResponseSchema.safeParse(await response.json());
    if (!parsed.success) return outputLimits;
    for (const entry of parsed.data.data) {
      if (!entry.model_name) continue;
      const info = entry.model_info ?? {};
      const outputLimit = readOutputTokenLimit(info.max_output_tokens) ?? null;
      const previousLimit = outputLimits.get(entry.model_name);
      // A routed alias can land on any deployment. Use the smallest stated
      // limit, or leave it unknown if any deployment omits a valid limit.
      outputLimits.set(
        entry.model_name,
        previousLimit === undefined
          ? outputLimit
          : previousLimit === null || outputLimit === null
            ? null
            : Math.min(previousLimit, outputLimit),
      );
    }
  } catch {
    // Timeout, invalid JSON and non-LiteLLM endpoints keep ordinary discovery.
  }
  return outputLimits;
}

/** Only provider-published positive integers that fit the stored integer column. */
export function readOutputTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 2_147_483_647
    ? value
    : undefined;
}

const ResponseSchema = z.object({
  data: z.array(
    z.object({
      model_name: z.string().optional(),
      model_info: z
        .object({
          max_output_tokens: z.unknown().optional(),
        })
        .nullish(),
    }),
  ),
});
