import type { archestraApiTypes } from "@shared";

type Config = archestraApiTypes.GetConfigResponses["200"];

export function makeConfig(
  overrides: {
    enterpriseFeatures?: Partial<Config["enterpriseFeatures"]>;
    features?: Partial<Config["features"]>;
    providerBaseUrls?: Config["providerBaseUrls"];
  } = {},
): Config {
  return {
    enterpriseFeatures: {
      core: false,
      knowledgeBase: false,
      fullWhiteLabeling: false,
      ...overrides.enterpriseFeatures,
    },
    features: {
      orchestratorK8sRuntime: false,
      advancedToolFeaturesEnabled: false,
      byosEnabled: false,
      byosVaultKvVersion: "1",
      azureOpenAiEntraIdEnabled: false,
      bedrockIamAuthEnabled: false,
      geminiVertexAiEnabled: false,
      globalToolPolicy: "permissive",
      incomingEmail: { enabled: false },
      mcpServerBaseImage: "",
      orchestratorK8sNamespace: "",
      isQuickstart: false,
      ngrokDomain: "",
      virtualKeyDefaultExpirationSeconds: 3600,
      mcpSandboxDomain: null,
      ...overrides.features,
    },
    providerBaseUrls: overrides.providerBaseUrls ?? {},
  };
}

export const configSeed = makeConfig();

type PublicConfig = archestraApiTypes.GetPublicConfigResponses["200"];

export function makePublicConfig(
  overrides: Partial<PublicConfig> = {},
): PublicConfig {
  return {
    disableBasicAuth: false,
    disableInvitations: false,
    analytics: {
      enabled: false,
      posthog: { key: "", host: "" },
    },
    ...overrides,
  };
}

export const publicConfigSeed = makePublicConfig();

type Health = archestraApiTypes.GetHealthResponses["200"];

export function makeHealth(overrides: Partial<Health> = {}): Health {
  return {
    name: "archestra-test",
    status: "ok",
    version: "0.0.0-test",
    ...overrides,
  };
}

export const healthSeed = makeHealth();
