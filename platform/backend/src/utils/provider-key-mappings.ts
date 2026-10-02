import {
  providerHasEndpointLocalModels,
  type SupportedProvider,
} from "@archestra/shared";
import { LlmProviderApiKeyModelLinkModel } from "@/models";
import { ApiError } from "@/types";

// ===================================================================
// Public API
// ===================================================================

/**
 * Validate the provider API keys a credential (virtual key, LLM OAuth client)
 * routes to.
 *
 * A credential maps one key per provider, except for providers whose keys are
 * separate servers with their own models (vLLM, Ollama, Azure, …): there each
 * key is another endpoint, so reaching two of them takes two mappings, and
 * requests pick the endpoint that serves the model
 * (`selectMappedProviderKey`). For a credential-style provider every key
 * reaches the same catalog, so a second one would only make it ambiguous which
 * account is billed.
 */
export function assertValidProviderKeyMappings(
  mappings: Array<{ provider: SupportedProvider; providerApiKeyId: string }>,
): void {
  const providers = new Set<SupportedProvider>();
  const providerApiKeyIds = new Set<string>();
  for (const mapping of mappings) {
    if (providerApiKeyIds.has(mapping.providerApiKeyId)) {
      throw new ApiError(
        400,
        `Provider API key "${mapping.providerApiKeyId}" is mapped more than once.`,
      );
    }
    providerApiKeyIds.add(mapping.providerApiKeyId);

    if (
      providers.has(mapping.provider) &&
      !providerHasEndpointLocalModels(mapping.provider)
    ) {
      throw new ApiError(
        400,
        `Only one provider API key can be mapped for provider "${mapping.provider}".`,
      );
    }
    providers.add(mapping.provider);
  }
}

/**
 * Pick which of a credential's mapped provider keys serves a request.
 *
 * `mappings` must already be in preference order. With one key for the
 * provider, that key answers. With several (only possible for providers whose
 * keys are separate endpoints), the first key whose endpoint serves the
 * requested model wins: sending a model to a sibling server that does not host
 * it is a guaranteed upstream 404. When the model is unknown, or no request
 * model exists (model listing), the first key answers.
 */
export async function selectMappedProviderKey<
  T extends { provider: SupportedProvider; providerApiKeyId: string },
>(params: {
  mappings: T[];
  provider: SupportedProvider;
  modelId?: string | null;
}): Promise<T | undefined> {
  const candidates = params.mappings.filter(
    (mapping) => mapping.provider === params.provider,
  );
  const [first] = candidates;
  if (
    candidates.length <= 1 ||
    !params.modelId ||
    !providerHasEndpointLocalModels(params.provider)
  ) {
    return first;
  }

  const servingKeyIds =
    await LlmProviderApiKeyModelLinkModel.findApiKeyIdsServingModelId({
      provider: params.provider,
      modelId: params.modelId,
    });
  if (!servingKeyIds) {
    return first;
  }
  const serving = new Set(servingKeyIds);
  return (
    candidates.find((mapping) => serving.has(mapping.providerApiKeyId)) ?? first
  );
}
