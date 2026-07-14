import logger from "@/logging";

// Some models (reasoning models in particular) reject `temperature`/`top_p`
// instead of ignoring them, returning a validation error such as
// "`temperature` is deprecated for this model." Rather than maintain a brittle
// per-model allowlist of which params each model accepts, detect the rejection,
// strip the offending param(s), and retry the request once. This is shared by
// the provider adapters (Bedrock, Anthropic); each supplies a `strip` that maps
// the canonical param names onto its own request/command shape.

export type SamplingParam = "temperature" | "top_p";

// Wire-level tokens that show up in provider errors, mapped to the canonical
// param each represents. `topp` covers Bedrock's camelCase `topP` once
// lowercased.
const SAMPLING_PARAM_TOKENS: Record<string, SamplingParam> = {
  temperature: "temperature",
  top_p: "top_p",
  "top-p": "top_p",
  topp: "top_p",
};

const REJECTION_PATTERN =
  /deprecated|not supported|unsupported|does not support|isn't supported|not allowed/;

/**
 * Return which sampling params an upstream error is rejecting, or [] when the
 * error isn't a "deprecated / not supported" sampling-param rejection. Reads the
 * error's `message` and (when present) `responseBody`, so it works across
 * providers that surface the rejection text in either field.
 *
 * @public — exercised directly by unit tests
 */
export function detectRejectedSamplingParams(error: unknown): SamplingParam[] {
  if (!error || typeof error !== "object") return [];
  const { message, responseBody } = error as {
    message?: string;
    responseBody?: string;
  };
  const text = `${message ?? ""} ${responseBody ?? ""}`.toLowerCase();
  if (!REJECTION_PATTERN.test(text)) return [];
  const affected = new Set<SamplingParam>();
  for (const [token, param] of Object.entries(SAMPLING_PARAM_TOKENS)) {
    if (text.includes(token)) affected.add(param);
  }
  return [...affected];
}

/**
 * Run a provider request and, if it fails solely because the model rejects a
 * sampling param, strip that param and retry exactly once. Provider-agnostic:
 * `strip` maps the rejected params onto the provider's own request/command shape
 * and returns null when none were actually set (so there is nothing worth
 * retrying). The retry only runs on an already-failing request, so it adds no
 * latency to the happy path.
 */
export async function withSamplingParamFallback<TInput, TResult>(params: {
  input: TInput;
  run: (input: TInput) => Promise<TResult>;
  strip: (input: TInput, rejected: SamplingParam[]) => TInput | null;
  logContext?: Record<string, unknown>;
}): Promise<TResult> {
  const { input, run, strip, logContext } = params;
  try {
    return await run(input);
  } catch (error) {
    const rejected = detectRejectedSamplingParams(error);
    if (rejected.length === 0) throw error;
    const retryInput = strip(input, rejected);
    if (retryInput === null) throw error;
    logger.warn(
      { ...logContext, strippedParams: rejected },
      "[llm-proxy] model rejected sampling param(s); retrying without them",
    );
    return run(retryInput);
  }
}
