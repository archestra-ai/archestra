import type { SupportedProvider } from "@archestra/shared";

/**
 * The provider API keys a credential routes to. One key per provider, except
 * for providers whose keys are separate servers with their own models (vLLM,
 * Ollama, …): there each key is another endpoint, and requests go to the one
 * that serves the model.
 */
export type ProviderApiKeyMappings = Array<{
  provider: SupportedProvider;
  providerApiKeyId: string;
}>;

export function formatProviderKeySummary(
  providerApiKeys: Array<{ provider: string }>,
  /** Resolves the organization's own name for a provider (see integration overrides). */
  labelFor: (provider: SupportedProvider) => string,
): string {
  if (providerApiKeys.length === 0) {
    return "None";
  }

  return [
    ...new Set(
      providerApiKeys.map((mapping) =>
        labelFor(mapping.provider as SupportedProvider),
      ),
    ),
  ].join(", ");
}
