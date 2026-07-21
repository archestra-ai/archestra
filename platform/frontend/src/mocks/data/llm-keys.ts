import type { archestraApiTypes } from "@archestra/shared";

type LlmProviderApiKey =
  archestraApiTypes.GetLlmProviderApiKeysResponses["200"][number];

export function makeLlmProviderApiKey(
  overrides: Partial<LlmProviderApiKey> = {},
): LlmProviderApiKey {
  return {
    id: "test-llm-key",
    organizationId: "test-org",
    name: "test-llm-key",
    provider: "anthropic",
    secretId: "test-secret",
    scope: "personal",
    userId: "test-user-admin",
    teamId: null,
    baseUrl: null,
    inferenceBaseUrl: null,
    extraHeaders: null,
    isSystem: false,
    isPrimary: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    teamName: null,
    userName: "Test Admin",
    vaultSecretPath: null,
    vaultSecretKey: null,
    secretStorageType: "database",
    bestModelId: null,
    isAgentKey: false,
    ...overrides,
  };
}

type VirtualKeysList = archestraApiTypes.GetAllVirtualApiKeysResponses["200"];
type VirtualKey = VirtualKeysList["data"][number];
type VirtualKeyCreated = archestraApiTypes.CreateVirtualApiKeyResponses["200"];

export function makeVirtualKey(
  overrides: Partial<VirtualKey> = {},
): VirtualKey {
  return {
    id: "test-virtual-key",
    organizationId: "test-org",
    name: "test-virtual-key",
    keyType: "standard",
    secretId: "test-vk-secret",
    tokenStart: "archestra_test",
    scope: "personal",
    authorId: "test-user-admin",
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    teams: [],
    authorName: "Test Admin",
    providerApiKeys: [],
    ...overrides,
  };
}

export function makeVirtualKeysList(
  overrides: {
    keys?: VirtualKey[];
    pagination?: Partial<VirtualKeysList["pagination"]>;
  } = {},
): VirtualKeysList {
  const keys = overrides.keys ?? [];
  return {
    data: keys,
    pagination: {
      currentPage: 1,
      limit: 50,
      total: keys.length,
      totalPages: keys.length === 0 ? 0 : 1,
      hasNext: false,
      hasPrev: false,
      ...overrides.pagination,
    },
  };
}

export function makeCreatedVirtualKey(
  overrides: Partial<VirtualKeyCreated> = {},
): VirtualKeyCreated {
  return {
    ...makeVirtualKey(),
    value: "archestra_test_abcdef0123456789",
    ...overrides,
  };
}

export const llmProviderApiKeysSeed: archestraApiTypes.GetLlmProviderApiKeysResponses["200"] =
  [];

export const virtualKeysSeed = makeVirtualKeysList();
