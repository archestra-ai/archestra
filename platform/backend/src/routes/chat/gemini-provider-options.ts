/**
 * Builds the complete `providerOptions.google` object for a chat turn.
 *
 * Every Gemini concern is resolved here rather than in separate blocks because
 * the caller assigns the `google` key wholesale — a second assignment replaces
 * the first, silently dropping whatever it had set.
 *
 * Thinking level and thought summaries are distinct knobs: `thinkingLevel` sets
 * how much the model reasons, `includeThoughts` asks for a readable summary of
 * reasoning that happens either way. Gemini bills thought tokens whether or not
 * summaries are requested, so a thinking turn always asks for them — otherwise
 * chat pays for reasoning it cannot show.
 */
import {
  type GeminiThinkingLevel,
  geminiThinkingConfigForEffort,
  supportsGeminiThoughtSummaries,
  type ThinkingEffortSetting,
} from "@archestra/shared";

type GoogleThinkingConfig = {
  thinkingLevel?: GeminiThinkingLevel;
  includeThoughts?: boolean;
};

type GoogleProviderOptions = {
  responseModalities?: ("TEXT" | "IMAGE")[];
  thinkingConfig?: GoogleThinkingConfig;
};

/**
 * Returns undefined when the turn needs no Google-specific options, so the
 * caller can leave `providerOptions` untouched.
 */
export function buildGeminiProviderOptions(params: {
  provider: string;
  selectedModel: string;
  isGeminiImageModel: boolean;
  thinkingEffort: ThinkingEffortSetting;
}): GoogleProviderOptions | undefined {
  const { provider, selectedModel, isGeminiImageModel, thinkingEffort } =
    params;

  if (provider !== "gemini") {
    return undefined;
  }

  if (isGeminiImageModel) {
    return { responseModalities: ["TEXT", "IMAGE"] };
  }

  const thinkingConfig = buildThinkingConfig(selectedModel, thinkingEffort);
  return thinkingConfig ? { thinkingConfig } : undefined;
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function buildThinkingConfig(
  selectedModel: string,
  effort: ThinkingEffortSetting,
): GoogleThinkingConfig | undefined {
  // Auto lands in the same branch as a model with no selectable level: both
  // mean "send no level and let the model reason as it would have".
  const level =
    effort === null
      ? null
      : geminiThinkingConfigForEffort(selectedModel, effort);

  if (level === null) {
    // No level to send, so the model reasons at its own default. Ask for
    // summaries on the models that reason by default; on the rest, thinking is
    // inactive and requesting summaries of it is a 400.
    return supportsGeminiThoughtSummaries(selectedModel)
      ? { includeThoughts: true }
      : undefined;
  }

  if (level.thinkingLevel === "minimal") {
    // Nothing worth summarizing, and the smallest request is the safest one.
    // Keyed on the resolved level, not the effort: `low` still reasons on the
    // models that cannot go below it, and that reasoning is worth showing.
    return level;
  }

  // An explicit level makes thinking active regardless of what the model does
  // by default, so summaries are safe here even on flash-lite — which
  // `supportsGeminiThoughtSummaries` reports false for on the strength of its
  // default-off behavior.
  return { ...level, includeThoughts: true };
}
