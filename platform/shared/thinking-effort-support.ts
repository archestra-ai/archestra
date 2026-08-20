import { supportsGeminiThinkingEffort } from "./gemini-models";
import {
  anthropicSupportsThinkingEffort,
  type SupportedProvider,
} from "./model-constants";
import { supportsOpenAiThinkingEffort } from "./openai-models";

/**
 * Whether a chosen reasoning depth reaches the provider for this model, and so
 * whether the composer should offer the control at all.
 *
 * Both halves matter. The provider decides which vocabulary the request speaks;
 * the model decides whether it takes a depth at all. `openai` in particular is
 * a protocol, not a vendor — the same credential serves Fireworks, DeepSeek and
 * Cerebras catalogs — so the model id has to be checked even once the provider
 * matches.
 *
 * Self-hosted providers are the exception to "the id decides": an operator
 * names a model whatever they like (`--served-model-name`, an Ollama tag, a
 * fine-tune), so no rule written against the id can tell whether it reasons.
 * They are answered from `supportsReasoningEffort` on the row instead, which
 * carries what the serving backend or the registry said — see
 * {@link modelSupportsThinkingEffort}.
 *
 * Lives apart from `thinking-effort.ts` so that file stays provider-neutral and
 * the per-provider catalog modules can keep importing the vocabulary from it.
 */
export function supportsThinkingEffort(
  provider: string,
  modelId: string,
): boolean {
  switch (provider) {
    case "gemini":
      return supportsGeminiThinkingEffort(modelId);
    case "openai":
      return supportsOpenAiThinkingEffort(modelId);
    case "anthropic":
      return anthropicSupportsThinkingEffort(modelId);
    default:
      // Providers that reach the same models through another surface (bedrock,
      // azure, github-copilot, …) are deliberately out: each speaks its own
      // reasoning dialect, and none is wired through the chat route yet.
      return false;
  }
}

/**
 * The composer's verdict for one model row: the id-based rules above, plus the
 * self-hosted providers that carry the answer on the row.
 *
 * `supportsReasoningEffort` is tri-state and only `true` opens the control. A
 * null means no source claimed the model reasons, and the false there is worth
 * more than the control: on this class of server an unwanted depth is not a
 * cosmetic extra field — Ollama rejects `think` outright on a model that cannot
 * think, so a wrong `true` would turn every send into an error while a wrong
 * null only leaves the composer as it is today.
 *
 * `ollama-native` is excluded on purpose even when the row says the model
 * thinks. Its wire field is a boolean, so Low, Medium and High would all send
 * `think: true` — three options that produce one behavior. Thinking is turned
 * on and off per model on the Models page for that provider instead.
 */
export function modelSupportsThinkingEffort(model: {
  provider: string;
  modelId: string;
  supportsReasoningEffort?: boolean | null;
}): boolean {
  const { provider, modelId, supportsReasoningEffort } = model;
  if (isThinkingEffortSelfHostedProvider(provider)) {
    return supportsReasoningEffort === true;
  }
  return supportsThinkingEffort(provider, modelId);
}

/**
 * Self-hosted providers whose depth the chat route can actually send: both
 * speak OpenAI's `reasoning_effort` on `/v1/chat/completions` — vLLM turns it
 * into the chat template's thinking switch, Ollama into its `think` field.
 *
 * Listed explicitly rather than derived from the keyless-provider set they
 * currently match, so a future self-hosted provider does not silently inherit
 * a wire field its server has never seen.
 */
const THINKING_EFFORT_SELF_HOSTED_PROVIDERS = new Set<SupportedProvider>([
  "ollama",
  "vllm",
]);

export function isThinkingEffortSelfHostedProvider(provider: string): boolean {
  return THINKING_EFFORT_SELF_HOSTED_PROVIDERS.has(
    provider as SupportedProvider,
  );
}
