import {
  APP_RECORDING_DEFAULT_MAX_FINAL_CUT_MS,
  type archestraApiTypes,
  DEFAULT_CHAT_ATTACHMENT_STORAGE_BYTES,
} from "@archestra/shared";

type Config = archestraApiTypes.GetConfigResponses["200"];

export function makeConfig(
  overrides: {
    enterpriseFeatures?: Partial<Config["enterpriseFeatures"]>;
    smallTeamTier?: Partial<Config["smallTeamTier"]>;
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
    smallTeamTier: {
      threshold: 30,
      userCount: 0,
      smallTeam: true,
      envFlag: false,
      communicate: true,
      ...overrides.smallTeamTier,
    },
    features: {
      betaEnabled: false,
      orchestratorK8sRuntime: false,
      sandbox: false,
      sandboxArtifactBytesLimit: DEFAULT_CHAT_ATTACHMENT_STORAGE_BYTES,
      chatAttachmentStorageBytesLimit: DEFAULT_CHAT_ATTACHMENT_STORAGE_BYTES,
      apiBodyLimitBytes: 70 * 1024 * 1024,
      byosEnabled: false,
      byosVaultKvVersion: "1",
      azureOpenAiEntraIdEnabled: false,
      anthropicWifEnabled: false,
      bedrockIamAuthEnabled: false,
      geminiVertexAiEnabled: false,
      incomingEmail: { enabled: false },
      mcpServerBaseImage: "",
      orchestratorK8sNamespace: "",
      environmentNamespaces: [],
      isQuickstart: false,
      ngrokDomain: "",
      virtualKeyDefaultExpirationSeconds: 3600,
      mcpSandboxDomain: null,
      chatSecretScanEnabled: true,
      chatIncognitoEnabled: false,
      agentHooksEnabled: false,
      chatopsTelegramEnabled: false,
      kbAutoSyncPermissionsEnabled: false,
      hackathonRecorderEnabled: true,
      // Off by default, exactly as a real deployment has it.
      hackathonVideoDownloadEnabled: false,
      hackathonMaxFinalCutMs: APP_RECORDING_DEFAULT_MAX_FINAL_CUT_MS,
      hackathonGalleryRepo: null,
      ...overrides.features,
      maintenanceMode: overrides.features?.maintenanceMode ?? null,
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
    disableImpersonation: false,
    devAutoLoginEnabled: false,
    enterpriseCoreActive: false,
    mcpSandboxDomain: null,
    analytics: {
      enabled: false,
      instanceId: null,
      posthog: { key: "", host: "" },
    },
    ...overrides,
    maintenanceMode: overrides.maintenanceMode ?? null,
    siteNotificationMessage: overrides.siteNotificationMessage ?? null,
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
