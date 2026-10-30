import {
  credentialRequiresPerUserScope,
  PROVIDERS_REQUIRING_BASE_URL,
  type SupportedProvider,
} from "@archestra/shared";
import { OPENCODE_PRIMARY_PROVIDERS } from "@archestra/shared/opencode-provider-routes";
import ConnectionSetupModel from "@/models/connection-setup";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import TeamModel from "@/models/team";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";

/** Automatic access never includes personal or subscription credentials. */
export async function getSharedPrimaryProviderKeys(organizationId: string) {
  const candidates =
    await LlmProviderApiKeyModel.findSharedPrimaryKeys(organizationId);
  const keys = await Promise.all(
    candidates.map(async (key) => {
      if (
        key.requiresReauthentication ||
        (PROVIDERS_REQUIRING_BASE_URL.has(key.provider) && !key.baseUrl?.trim())
      )
        return null;
      const apiKey = key.secretId
        ? await getSecretValueForLlmProviderApiKey(key.secretId)
        : undefined;
      return credentialRequiresPerUserScope({ provider: key.provider, apiKey })
        ? null
        : key;
    }),
  );
  return keys.filter((key) => key !== null);
}

export async function resolveVirtualKeyProviderMappings(
  virtualApiKeyId: string,
) {
  const key = await VirtualApiKeyModel.findById(virtualApiKeyId);
  if (!key) return [];
  const mappings =
    await VirtualApiKeyModel.getProviderApiKeysForRouting(virtualApiKeyId);
  const ownerPrimaries =
    key.keyType === "standard" &&
    key.authorId &&
    (await VirtualApiKeyModel.isPersonal(key)) &&
    (await ConnectionSetupModel.hasManagedPrimaryInstallation({
      organizationId: key.organizationId,
      userId: key.authorId,
      virtualApiKeyId,
    }))
      ? (
          await LlmProviderApiKeyModel.getUsablePrimaryKeys({
            organizationId: key.organizationId,
            userId: key.authorId,
            userTeamIds: await TeamModel.getUserTeamIds(key.authorId),
          })
        ).filter(
          (primary) =>
            primary.userId === key.authorId &&
            OPENCODE_PRIMARY_PROVIDERS.includes(primary.provider),
        )
      : [];
  return resolveProviderMappings({
    organizationId: key.organizationId,
    includeFutureProviders:
      key.keyType === "standard" && key.includeFutureProviders,
    mappings: [
      ...mappings,
      ...ownerPrimaries
        .filter(
          (primary) =>
            !mappings.some((mapping) => mapping.provider === primary.provider),
        )
        .map(primaryProviderMapping),
    ],
    mapPrimary: primaryProviderMapping,
  });
}

/** Resolve automatic access at request time without changing explicit overrides. */
export async function resolveProviderMappings<
  T extends { provider: SupportedProvider; providerApiKeyId: string },
>(params: {
  organizationId: string;
  includeFutureProviders: boolean;
  mappings: T[];
  mapPrimary: (
    key: Awaited<ReturnType<typeof getSharedPrimaryProviderKeys>>[number],
  ) => T;
}): Promise<T[]> {
  if (!params.includeFutureProviders) return params.mappings;
  const providers = new Set(params.mappings.map((mapping) => mapping.provider));
  const primaries = await getSharedPrimaryProviderKeys(params.organizationId);
  return [
    ...params.mappings,
    ...primaries
      .filter((primary) => !providers.has(primary.provider))
      .map(params.mapPrimary),
  ];
}

function primaryProviderMapping(
  primary: Pick<
    Awaited<ReturnType<typeof getSharedPrimaryProviderKeys>>[number],
    | "id"
    | "provider"
    | "name"
    | "organizationId"
    | "secretId"
    | "scope"
    | "userId"
    | "inferenceBaseUrl"
    | "baseUrl"
  >,
) {
  return {
    provider: primary.provider,
    providerApiKeyId: primary.id,
    providerApiKeyName: primary.name,
    organizationId: primary.organizationId,
    providerApiKeyProvider: primary.provider,
    secretId: primary.secretId,
    scope: primary.scope,
    userId: primary.userId,
    baseUrl: primary.inferenceBaseUrl ?? primary.baseUrl,
  };
}
