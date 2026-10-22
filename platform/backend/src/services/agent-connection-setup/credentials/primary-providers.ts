import {
  PROVIDERS_REQUIRING_BASE_URL,
  providerDisplayNames,
  providerRequiresPerUserCredential,
  type SupportedProvider,
} from "@archestra/shared";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import ModelTeamModel from "@/models/model-team";
import OrganizationModel from "@/models/organization";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import {
  getSharedPrimaryProviderKeys,
  resolveVirtualKeyProviderMappings,
} from "@/services/virtual-key-providers";
import { ApiError } from "@/types";
import { readVirtualKeyValue } from "../../connection-setup";
import type { SetupScriptProxySection } from "../types";

type PrimaryProviderContext = {
  organizationId: string;
  userId: string;
  userTeamIds: string[];
  supportedProviders: readonly SupportedProvider[];
  /**
   * Keys an admin mapped for the client being set up. When any is still
   * usable they replace the user's primary keys, and the user needs no access
   * of their own to them.
   */
  includeFutureProviders?: boolean;
  mappedKeys?: Array<{
    provider: SupportedProvider;
    providerApiKeyId: string;
  }> | null;
};

/**
 * Resolve the credentials for a multi-provider personal key — the client's
 * admin-mapped keys, else the user's usable primary keys — then create or
 * refresh the key.
 */
export async function ensurePrimaryProviderKey(
  params: PrimaryProviderContext & { keyName: string },
) {
  const name = params.keyName;
  const existing = await VirtualApiKeyModel.findByAuthorScopeName({
    organizationId: params.organizationId,
    authorId: params.userId,
    scope: "personal",
    name,
  });
  // Organization defaults apply only when issuing a key for the first time.
  const includeFutureProviders =
    existing?.includeFutureProviders ?? params.includeFutureProviders;
  const context = existing?.includeFutureProviders
    ? {
        ...params,
        mappedKeys: await VirtualApiKeyModel.getProviderApiKeys(existing.id),
      }
    : params;
  const mapped = await getMappedKeys(context);
  const primaries = includeFutureProviders
    ? (await getSharedPrimaryProviderKeys(params.organizationId)).filter(
        (key) => params.supportedProviders.includes(key.provider),
      )
    : await getPrimaryKeys(params);
  const keys = includeFutureProviders
    ? [
        ...mapped,
        ...primaries.filter(
          (key) =>
            !mapped.some((override) => override.provider === key.provider),
        ),
      ]
    : mapped.length > 0
      ? mapped
      : primaries;
  if (keys.length === 0) {
    throw new ApiError(
      400,
      "No usable primary provider keys are available. Mark a compatible provider key as primary, ask an admin to choose provider keys for this client, or choose another routing option.",
    );
  }
  const providerApiKeys = keys.map((key) => ({
    provider: key.provider,
    providerApiKeyId: key.id,
  }));
  if (existing && existing.keyType !== "standard") {
    throw new ApiError(
      409,
      `A passthrough key already uses the name ${name}. Rename it before generating setup.`,
    );
  }
  if (existing && (await readVirtualKeyValue(existing.id))) {
    if (!existing.includeFutureProviders)
      await VirtualApiKeyModel.update({
        id: existing.id,
        name,
        scope: "personal",
        authorId: params.userId,
        teamIds: [],
        providerApiKeys,
      });
    return { virtualApiKeyId: existing.id, provider: keys[0].provider };
  }
  if (existing) await VirtualApiKeyModel.delete(existing.id);
  const { virtualKey } = await VirtualApiKeyModel.create({
    organizationId: params.organizationId,
    authorId: params.userId,
    scope: "personal",
    name,
    includeFutureProviders,
    providerApiKeys: includeFutureProviders
      ? mapped.map((key) => ({
          provider: key.provider,
          providerApiKeyId: key.id,
        }))
      : providerApiKeys,
  });
  // Match connection-key creation: concurrent first setups converge on the
  // oldest key so later catalog refreshes update every installation.
  const winner = await VirtualApiKeyModel.findByAuthorScopeName({
    organizationId: params.organizationId,
    authorId: params.userId,
    scope: "personal",
    name,
  });
  if (winner && winner.id !== virtualKey.id) {
    await VirtualApiKeyModel.delete(virtualKey.id);
    if (!winner.includeFutureProviders)
      await VirtualApiKeyModel.update({
        id: winner.id,
        name,
        scope: "personal",
        authorId: params.userId,
        teamIds: [],
        providerApiKeys,
      });
    return { virtualApiKeyId: winner.id, provider: keys[0].provider };
  }
  return { virtualApiKeyId: virtualKey.id, provider: keys[0].provider };
}

/** Recheck access and, for all-provider setups, primary status at download time. */
export async function getVirtualKeyProviderCatalog(
  params: PrimaryProviderContext & {
    virtualApiKeyId: string;
    provider?: SupportedProvider;
    /** The client named when no model can run in it. */
    clientLabel?: string;
    /**
     * Runtime refresh only. A selected key or model list that is now empty
     * returns no providers. Installer calls still fail so a new setup is generated.
     */
    allowEmpty?: boolean;
  },
): Promise<NonNullable<SetupScriptProxySection["primaryProviders"]>> {
  const virtualKey = await VirtualApiKeyModel.findById(params.virtualApiKeyId);
  const automaticMappings = virtualKey?.includeFutureProviders
    ? await resolveVirtualKeyProviderMappings(params.virtualApiKeyId)
    : null;
  const [userKeys, mappedKeys, mappings] = await Promise.all([
    automaticMappings
      ? LlmProviderApiKeyModel.findByIds(
          automaticMappings.map((key) => key.providerApiKeyId),
        )
      : params.provider
        ? LlmProviderApiKeyModel.getAvailableKeysForUser(
            params.organizationId,
            params.userId,
            params.userTeamIds,
          )
        : getPrimaryKeys(params),
    getMappedKeys(params),
    automaticMappings ??
      VirtualApiKeyModel.getProviderApiKeys(params.virtualApiKeyId),
  ]);
  // Admin-mapped keys stand in for the user's own access.
  const keys = [
    ...mappedKeys,
    ...userKeys.filter(
      (key) => !mappedKeys.some((mapped) => mapped.id === key.id),
    ),
  ];
  // Connection keys can be reused by other clients/providers. Only publish the
  // provider selected in this setup, never the key's unrelated mappings.
  const selectedMappings = mappings.filter(
    (mapping) =>
      params.supportedProviders.includes(mapping.provider) &&
      (!params.provider || mapping.provider === params.provider),
  );
  const boundIds = new Set(
    selectedMappings.map((mapping) => mapping.providerApiKeyId),
  );
  const selected = keys.filter(
    (key) =>
      boundIds.has(key.id) &&
      !key.requiresReauthentication &&
      (!PROVIDERS_REQUIRING_BASE_URL.has(key.provider) ||
        Boolean(key.baseUrl?.trim())),
  );
  if (!selected.length || selected.length !== selectedMappings.length) {
    if (params.allowEmpty && selected.length === 0) return [];
    throw new ApiError(
      410,
      "Model provider access changed. Generate a new setup command.",
    );
  }
  const models = await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds(
    selected.map((key) => key.id),
  );
  // Match the model-router catalog's virtual-key grant check.
  const allowedModelIds = await ModelTeamModel.filterAllowedModelIds({
    modelIds: models.map(({ model }) => model.id),
    organizationId: params.organizationId,
    userId:
      virtualKey?.scope === "personal"
        ? (virtualKey.authorId ?? undefined)
        : undefined,
    action: "use",
  });
  const providers = [...new Set(selected.map((key) => key.provider))];
  const entries = providers
    .map((provider) => ({
      provider,
      name:
        selected.filter((key) => key.provider === provider).length === 1
          ? (selected.find((key) => key.provider === provider)?.name ??
            providerDisplayNames[provider])
          : providerDisplayNames[provider],
      models: models
        .filter(
          ({ model }) =>
            model.provider === provider &&
            allowedModelIds.has(model.id) &&
            ModelModel.supportsTextChat(model) &&
            // OpenCode sends tools on every agent turn. Unknown (null) stays.
            model.supportsToolCalling !== false,
        )
        .map(({ model }) => ({
          id: model.modelId,
          name: model.modelId,
          context: model.customContextLength ?? model.contextLength,
          output: model.customOutputLength ?? model.outputLength,
        })),
    }))
    .filter((entry) => entry.models.length > 0);
  const clientLabel = params.clientLabel ?? "OpenCode";
  if (!entries.length) {
    if (params.allowEmpty) return [];
    throw new ApiError(
      400,
      `No model from the selected providers can run in ${clientLabel}. ${clientLabel} needs models that support tool calling. Sync the provider's models or choose another provider.`,
    );
  }
  const preferred = await getPreferredModels(params);
  const lead = preferred.find(({ provider, modelId }) =>
    entries.some(
      (entry) =>
        entry.provider === provider &&
        entry.models.some((model) => model.id === modelId),
    ),
  )?.provider;
  return [
    ...entries.filter((entry) => entry.provider === lead),
    ...entries.filter((entry) => entry.provider !== lead),
  ];
}

/**
 * OpenCode starts on the first provider it is given, so lead with the one the
 * organization's default model uses.
 * Returned in preference order; the caller uses the first one it really offers.
 */
async function getPreferredModels(params: {
  organizationId: string;
}): Promise<Array<{ provider: SupportedProvider; modelId: string }>> {
  const organization = await OrganizationModel.getById(params.organizationId);
  const ids = [organization?.defaultModelId].filter((id): id is string =>
    Boolean(id),
  );
  const found = await ModelModel.findByIds(ids);
  return ids.flatMap((id) => {
    const model = found.find((candidate) => candidate.id === id);
    return model ? [{ provider: model.provider, modelId: model.modelId }] : [];
  });
}

async function getMappedKeys(params: PrimaryProviderContext) {
  const mapped = params.mappedKeys ?? [];
  const keys = await LlmProviderApiKeyModel.findByIds(
    mapped.map((mapping) => mapping.providerApiKeyId),
  );
  return keys.filter(
    (key) =>
      key.organizationId === params.organizationId &&
      mapped.some(
        (mapping) =>
          mapping.providerApiKeyId === key.id &&
          mapping.provider === key.provider,
      ) &&
      params.supportedProviders.includes(key.provider) &&
      // A per-user credential is never shared through an admin mapping.
      !providerRequiresPerUserCredential(key.provider) &&
      !key.requiresReauthentication &&
      (!PROVIDERS_REQUIRING_BASE_URL.has(key.provider) ||
        Boolean(key.baseUrl?.trim())),
  );
}

async function getPrimaryKeys(params: PrimaryProviderContext) {
  return (await LlmProviderApiKeyModel.getUsablePrimaryKeys(params)).filter(
    (key) => params.supportedProviders.includes(key.provider),
  );
}
