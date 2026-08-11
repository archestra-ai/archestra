import { supportsGeminiThinkingEffort } from "./gemini-models";
import { anthropicSupportsThinkingEffort } from "./model-constants";
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
