/**
 * The reasoning-depth fragment of `providerOptions.openai` for a chat turn.
 *
 * A fragment rather than the whole object because two mutually exclusive blocks
 * in the chat route already own that key — one for the Responses transport
 * (`store`, `reasoningSummary`) and one for chat-completions
 * (`maxCompletionTokens`) — and each builds a fresh object. Spreading this into
 * both keeps a third assignment from silently dropping what they set.
 *
 * `reasoning_effort` is accepted on both transports, so no branch is needed
 * here; only the model matters.
 */
import {
  openAiReasoningEffortForEffort,
  type ThinkingEffort,
  type ThinkingEffortSetting,
} from "@archestra/shared";

type OpenAiThinkingProviderOptions = {
  reasoningEffort: ThinkingEffort;
};

/**
 * Returns undefined when the model takes no reasoning effort, so the caller
 * spreads nothing.
 */
export function buildOpenAiThinkingProviderOptions(params: {
  provider: string;
  selectedModel: string;
  thinkingEffort: ThinkingEffortSetting;
}): OpenAiThinkingProviderOptions | undefined {
  const { provider, selectedModel, thinkingEffort } = params;

  // No chosen depth sends no field at all, so the model reasons as it would.
  if (provider !== "openai" || thinkingEffort === null) {
    return undefined;
  }

  const reasoningEffort = openAiReasoningEffortForEffort(
    selectedModel,
    thinkingEffort,
  );
  return reasoningEffort === null ? undefined : { reasoningEffort };
}
