import type { archestraApiTypes } from "@archestra/shared";

type Organization = archestraApiTypes.GetOrganizationResponses["200"];

export function makeOrganization(
  overrides: Partial<Organization> = {},
): Organization {
  return {
    id: "test-org",
    name: "Test Org",
    slug: "test-org",
    analyticsInstanceId: "00000000-0000-4000-8000-000000000001",
    logo: null,
    logoDark: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    metadata: null,
    onboardingComplete: true,
    onboardingSurveyCompletedAt: null,
    theme: "modern-minimal",
    customFont: "inter",
    convertToolResultsToToon: false,
    onlineMcpCatalogEnabled: true,
    mcpIdleHibernationEnabled: false,
    onlineSkillCatalogEnabled: true,
    skillMarketplaceAnonymousAccess: false,
    skillToolsEnabled: false,
    appsHackathonRecorderEnabled: true,
    newAppsDisabledByDefault: false,
    newAppsLockedByDefault: false,
    compressionScope: "organization",
    defaultDiscoveredToolInvocationPolicy: "allow_when_context_is_untrusted",
    defaultDiscoveredToolResultPolicy: "mark_as_untrusted",
    allowChatFileUploads: false,
    allowToolAutoAssignment: true,
    // Configured, so the knowledge section renders its pages rather than the
    // "Configuration is needed" placeholder every route below /knowledge is
    // gated behind (`useIsKnowledgeBaseConfigured` reads exactly these two).
    //
    // The key id is deliberately one no spec creates. The Model Providers page
    // disables Delete on any key the organization names here, so an id that
    // collides with a key a test makes silently turns that key undeletable —
    // which is what `llm-key-1` did to the create/update/delete spec.
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
    embeddingChatApiKeyId: "seeded-knowledge-embedding-key",
    rerankerChatApiKeyId: null,
    rerankerModel: null,
    ocrChatApiKeyId: null,
    ocrModel: null,
    kbBm25K1: null,
    kbBm25B: null,
    kbContextualRetrievalMode: null,
    defaultLlmModel: null,
    defaultLlmProvider: "openai",
    defaultLlmApiKeyId: null,
    defaultModelId: null,
    defaultUserLimitValue: null,
    defaultUserLimitModel: null,
    defaultUserLimitCleanupInterval: "1h",
    defaultMemberRole: null,
    defaultAgentId: null,
    favicon: null,
    appName: null,
    ogDescription: null,
    footerText: null,
    chatLinks: null,
    onboardingWizard: null,
    chatPlaceholders: null,
    animateChatPlaceholders: false,
    iconLogo: null,
    iconLogoDark: null,
    chatErrorSupportMessage: null,
    slimChatErrorUi: false,
    requireTwoFactor: false,
    sessionMaxAgeSeconds: null,
    oauthAccessTokenLifetimeSeconds: 3600,
    connectionDefaultMcpGatewayId: null,
    connectionDefaultLlmProxyId: null,
    connectionDefaultClientId: null,
    connectionShownClientIds: null,
    connectionShownProviders: null,
    connectionBaseUrls: null,
    connectionDefaultProviderKeys: null,
    modelProviderOverrides: null,
    messagingChannelOverrides: null,
    knowledgeConnectorOverrides: null,
    defaultEnvironmentName: null,
    defaultEnvironmentNamespace: null,
    defaultEnvironmentDescription: null,
    defaultNetworkPolicy: null,
    defaultEnvironmentRestricted: false,
    defaultEnvironmentValidationRegex: null,
    defaultEnvironmentTrustedImageRegistries: null,
    ...overrides,
  };
}

export const organizationSeed = makeOrganization();

type AppearanceSettings =
  archestraApiTypes.GetAppearanceSettingsResponses["200"];

export function makeAppearanceSettings(
  overrides: Partial<AppearanceSettings> = {},
): AppearanceSettings {
  return {
    theme: "modern-minimal",
    customFont: "inter",
    logo: null,
    logoDark: null,
    favicon: null,
    iconLogo: null,
    iconLogoDark: null,
    appName: null,
    ogDescription: null,
    footerText: null,
    chatLinks: null,
    chatErrorSupportMessage: null,
    slimChatErrorUi: false,
    animateChatPlaceholders: false,
    ...overrides,
  };
}

export const appearanceSettingsSeed = makeAppearanceSettings();

type TeamsResponse = archestraApiTypes.GetTeamsResponses["200"];
type Team = TeamsResponse["data"][number];

export function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: "test-team",
    name: "Test Team",
    description: null,
    organizationId: "test-org",
    createdBy: "test-user-admin",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    convertToolResultsToToon: false,
    ...overrides,
  };
}

/** Paginated teams envelope; pass `teams: [...]` and pagination is derived. */
export function makeTeamsList(
  overrides: {
    teams?: Team[];
    pagination?: Partial<TeamsResponse["pagination"]>;
  } = {},
): TeamsResponse {
  const teams = overrides.teams ?? [];
  return {
    data: teams,
    pagination: {
      currentPage: 1,
      limit: 100,
      total: teams.length,
      totalPages: teams.length === 0 ? 0 : 1,
      hasNext: false,
      hasPrev: false,
      ...overrides.pagination,
    },
  };
}

export const teamsSeed = makeTeamsList();
