/**
 * The reasoning-depth fragment of a chat turn's `providerOptions`.
 *
 * A fragment rather than the whole object because two mutually exclusive blocks
 * in the chat route already own that key — one for the Responses transport
 * (`store`, `reasoningSummary`) and one for chat-completions
 * (`maxCompletionTokens`) — and each builds a fresh object. Spreading this into
 * both keeps a third assignment from silently dropping what they set.
 *
 * `reasoning_effort` is accepted on both transports, so no branch is needed
 * here; only the model matters.
 *
 * The self-hosted OpenAI-compatible providers take the same fragment, but under
 * their own namespace rather than `openai`: `@ai-sdk/openai-compatible` reads
 * `providerOptions[<provider name>]` and maps `reasoningEffort` onto the wire's
 * `reasoning_effort` itself. The caller owns that placement.
 */
import {
  isThinkingEffortSelfHostedProvider,
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
  if (thinkingEffort === null) {
    return undefined;
  }

  // A self-hosted server takes the depth verbatim: `low | medium | high` is
  // exactly what both accept, and neither has a vendor catalog to map against —
  // the id is whatever the operator launched the server with. vLLM turns the
  // field into its chat template's thinking switch, Ollama into `think`.
  // Reaching them at all is gated upstream by the model's row, since only the
  // composer's control puts a depth on the request.
  if (isThinkingEffortSelfHostedProvider(provider)) {
    return { reasoningEffort: thinkingEffort };
  }

  if (provider !== "openai") {
    return undefined;
  }

  const reasoningEffort = openAiReasoningEffortForEffort(
    selectedModel,
    thinkingEffort,
  );
  return reasoningEffort === null ? undefined : { reasoningEffort };
}
