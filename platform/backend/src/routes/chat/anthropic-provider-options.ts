/**
 * Builds the complete `providerOptions.anthropic` object for a chat turn.
 *
 * Only reasoning depth lives here today, but the key is assigned wholesale by
 * the caller — a second assignment would replace the first — so this stays the
 * one writer, the way the Gemini builder does for `google`.
 *
 * Deliberately does NOT set `thinking`. The AI SDK's `thinking` option carries
 * no `display` field, so visible reasoning depends on the fetch wrapper in
 * `clients/llm-client.ts` adding `display: "summarized"` — and that wrapper
 * skips any body that already declares `thinking`. Writing the field here would
 * buy nothing and cost the reasoning UI.
 */
import {
  anthropicEffortForThinkingEffort,
  type ThinkingEffort,
  type ThinkingEffortSetting,
} from "@archestra/shared";

type AnthropicProviderOptions = {
  effort?: ThinkingEffort;
};

/**
 * Returns undefined when the turn needs no Anthropic-specific options, so the
 * caller can leave `providerOptions` untouched.
 */
export function buildAnthropicProviderOptions(params: {
  provider: string;
  selectedModel: string;
  thinkingEffort: ThinkingEffortSetting;
}): AnthropicProviderOptions | undefined {
  const { provider, selectedModel, thinkingEffort } = params;

  // No chosen depth sends no field at all, so the model reasons as it would.
  if (provider !== "anthropic" || thinkingEffort === null) {
    return undefined;
  }

  const effort = anthropicEffortForThinkingEffort(
    selectedModel,
    thinkingEffort,
  );
  return effort === null ? undefined : { effort };
}
