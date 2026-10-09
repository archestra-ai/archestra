import {
  PROVIDERS_REQUIRING_BASE_URL,
  providerDisplayNames,
  type SupportedProvider,
} from "@archestra/shared";
import { OPENCODE_PRIMARY_PROVIDERS } from "@archestra/shared/opencode-provider-routes";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import ModelTeamModel from "@/models/model-team";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { ApiError } from "@/types";
import type { SetupScriptProxySection } from "./agent-connection-setup/types";
import { readVirtualKeyValue } from "./connection-setup";

type UserContext = {
  organizationId: string;
  userId: string;
  userTeamIds: string[];
};

/** Resolve all credentials before mutating the dedicated OpenCode key. */
export async function ensureOpenCodePrimaryKey(params: UserContext) {
  const keys = await getPrimaryKeys(params);
  if (keys.length === 0) {
    throw new ApiError(
      400,
      "No usable primary provider keys are available for OpenCode. Mark a compatible provider key as primary, or choose another routing option.",
    );
  }
  const name = "OpenCode primary providers";
  const providerApiKeys = keys.map((key) => ({
    provider: key.provider,
    providerApiKeyId: key.id,
  }));
  const existing = await VirtualApiKeyModel.findByAuthorScopeName({
    organizationId: params.organizationId,
    authorId: params.userId,
    scope: "personal",
    name,
  });
  if (existing && existing.keyType !== "standard") {
    throw new ApiError(
      409,
      "A passthrough key already uses the name OpenCode primary providers. Rename it before generating setup.",
    );
  }
  if (existing && (await readVirtualKeyValue(existing.id))) {
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
    providerApiKeys,
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
export async function getOpenCodeVirtualKeyCatalog(
  params: UserContext & {
    virtualApiKeyId: string;
    provider?: SupportedProvider;
  },
): Promise<NonNullable<SetupScriptProxySection["primaryProviders"]>> {
  const [keys, mappings] = await Promise.all([
    params.provider
      ? LlmProviderApiKeyModel.getAvailableKeysForUser(
          params.organizationId,
          params.userId,
          params.userTeamIds,
        )
      : getPrimaryKeys(params),
    VirtualApiKeyModel.getProviderApiKeys(params.virtualApiKeyId),
  ]);
  // Connection keys can be reused by other clients/providers. Only publish the
  // provider selected in this setup, never the key's unrelated mappings.
  const selectedMappings = mappings.filter(
    (mapping) => !params.provider || mapping.provider === params.provider,
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
  if (!selected.length || selected.length !== selectedMappings.length)
    throw new ApiError(
      410,
      "Model provider access changed. Generate a new OpenCode setup command.",
    );
  const models = await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds(
    selected.map((key) => key.id),
  );
  // Match the model-router catalog's virtual-key grant check.
  const allowedModelIds = await ModelTeamModel.filterAllowedModelIds({
    modelIds: models.map(({ model }) => model.id),
    organizationId: params.organizationId,
    action: "use",
  });
  const providers = [...new Set(selected.map((key) => key.provider))];
  return providers.map((provider) => ({
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
          ModelModel.supportsTextChat(model),
      )
      .map(({ model }) => ({
        id: model.modelId,
        name: model.modelId,
        context: model.customContextLength ?? model.contextLength,
        output: model.customOutputLength ?? model.outputLength,
      })),
  }));
}

async function getPrimaryKeys(params: UserContext) {
  return (await LlmProviderApiKeyModel.getUsablePrimaryKeys(params)).filter(
    (key) => OPENCODE_PRIMARY_PROVIDERS.includes(key.provider),
  );
}
