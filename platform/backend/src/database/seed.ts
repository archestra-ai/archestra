import {
  ADMIN_ROLE_NAME,
  ARCHESTRA_MCP_CATALOG_ID,
  BUILT_IN_AGENT_IDS,
  BUILT_IN_AGENT_NAMES,
  DUAL_LLM_MAIN_SYSTEM_PROMPT,
  DUAL_LLM_QUARANTINE_SYSTEM_PROMPT,
  PLAYWRIGHT_MCP_CATALOG_ID,
  PLAYWRIGHT_MCP_SERVER_NAME,
  POLICY_CONFIG_SYSTEM_PROMPT,
  type PredefinedRoleName,
  type SupportedProvider,
  SupportedProviders,
  testMcpServerCommand,
} from "@shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import config, { getProviderEnvApiKey } from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import {
  AgentModel,
  ChatApiKeyModel,
  InternalMcpCatalogModel,
  McpHttpSessionModel,
  MemberModel,
  OrganizationModel,
  TeamModel,
  TeamTokenModel,
  ToolModel,
  UserModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { modelSyncService } from "@/services/model-sync";
import {
  encryptSecretValue,
  ensureEncryptionKeyAvailable,
  isEncryptedSecret,
} from "@/utils/crypto";

/**
 * Seeds admin user
 */
export async function seedDefaultUserAndOrg(
  config: {
    email?: string;
    password?: string;
    role?: PredefinedRoleName;
    name?: string;
  } = {},
) {
  const user = await UserModel.createOrGetExistingDefaultAdminUser(config);
  const org = await OrganizationModel.getOrCreateDefaultOrganization();
  if (!user || !org) {
    throw new Error("Failed to seed admin user and default organization");
  }

  const existingMember = await MemberModel.getByUserId(user.id, org.id);

  if (!existingMember) {
    await MemberModel.create(user.id, org.id, config.role || ADMIN_ROLE_NAME);
  }
  logger.info("Seeded admin user and default organization");
  return user;
}

/**
 * Seeds Archestra MCP catalog and tools.
 * ToolModel.seedArchestraTools handles catalog creation with onConflictDoNothing().
 * Tools are NOT automatically assigned to agents - users must assign them manually.
 */
async function seedArchestraCatalogAndTools(): Promise<void> {
  await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
  logger.info("Seeded Archestra catalog and tools");
}

/**
 * Seeds Playwright browser preview MCP catalog.
 * This is a globally available catalog - tools are auto-included for all agents in chat.
 * Each user gets their own personal Playwright server instance when they click the Browser button.
 */
async function seedPlaywrightCatalog(): Promise<void> {
  const LEGACY_PLAYWRIGHT_MCP_SERVER_NAME = "playwright-browser";
  const playwrightLocalConfig = {
    // Pinned to v0.0.64 digest because v0.0.67 renamed --no-sandbox to --no-chromium-sandbox
    // but the image entrypoint still uses --no-sandbox, causing immediate crashes.
    dockerImage:
      "mcr.microsoft.com/playwright/mcp@sha256:50fee3932984dbf40fe67be11fe22d0050eca40705cf108099d7a1e0fe6a181c",
    transportType: "streamable-http" as const,
    // Explicit command overrides the image ENTRYPOINT to avoid breakage from upstream image changes.
    // v0.0.67 broke the entrypoint by renaming --no-sandbox to --no-chromium-sandbox without
    // updating the Dockerfile. Using explicit command+args makes us resilient to such changes.
    command: "node",
    // Full arguments including cli.js entry point and all Chromium/server flags:
    //   cli.js: the Playwright MCP server entry point
    //   --headless: run Chromium in headless mode
    //   --browser chromium: use Chromium browser
    //   --no-sandbox: required when running as root in containers (renamed to --no-chromium-sandbox in v0.0.67)
    //   --host 0.0.0.0: bind to all interfaces so K8s Service can route traffic to the pod
    //   --port 8080: enable HTTP transport mode (without --port, it runs in stdio mode and exits)
    //   --allowed-hosts *: allow connections from K8s Service DNS (default only allows localhost)
    //   --isolated: each Mcp-Session-Id gets its own browser context for session isolation
    //
    // Multi-replica support: The Mcp-Session-Id is stored in the database after the first
    // connection and reused by all backend pods so they share the same Playwright browser context.
    // See mcp-client.ts for session ID persistence logic.
    arguments: [
      "cli.js",
      "--headless",
      "--browser",
      "chromium",
      "--no-sandbox",
      "--host",
      "0.0.0.0",
      "--port",
      "8080",
      "--allowed-hosts",
      "*",
      "--isolated",
    ],
    httpPort: 8080,
  };

  // Read current catalog config before upsert to detect changes
  let existingCatalog = await InternalMcpCatalogModel.findById(
    PLAYWRIGHT_MCP_CATALOG_ID,
  );
  const legacyCatalogByName = await InternalMcpCatalogModel.findByName(
    LEGACY_PLAYWRIGHT_MCP_SERVER_NAME,
  );

  // One-time migration: remove legacy playwright catalog installations/resources.
  // This runs only when the old catalog name is present in the environment.
  if (
    existingCatalog?.name === LEGACY_PLAYWRIGHT_MCP_SERVER_NAME ||
    legacyCatalogByName
  ) {
    const catalogIdsToDelete = new Set<string>();
    if (existingCatalog?.name === LEGACY_PLAYWRIGHT_MCP_SERVER_NAME) {
      catalogIdsToDelete.add(existingCatalog.id);
    }
    if (legacyCatalogByName) {
      catalogIdsToDelete.add(legacyCatalogByName.id);
    }

    for (const catalogId of catalogIdsToDelete) {
      const deleted = await InternalMcpCatalogModel.delete(catalogId);
      if (deleted) {
        logger.info(
          { catalogId, legacyCatalogName: LEGACY_PLAYWRIGHT_MCP_SERVER_NAME },
          "Removed legacy Playwright catalog and related installations/resources",
        );
      }
    }

    existingCatalog = null;
  }

  // Only insert on first creation; never overwrite user edits on restart.
  // Future config changes (e.g., docker image pin updates) should use database migrations.
  await db
    .insert(schema.internalMcpCatalogTable)
    .values({
      id: PLAYWRIGHT_MCP_CATALOG_ID,
      name: PLAYWRIGHT_MCP_SERVER_NAME,
      description:
        "Browser automation for chat - each user gets their own isolated browser session",
      serverType: "local",
      requiresAuth: false,
      localConfig: playwrightLocalConfig,
    })
    .onConflictDoNothing();

  logger.info("Seeded Playwright browser preview catalog");
}

/**
 * Seeds test MCP server for development
 * This creates a simple MCP server in the catalog that has one tool: print_archestra_test
 */
async function seedTestMcpServer(): Promise<void> {
  // Only seed in development, or when ENABLE_TEST_MCP_SERVER is explicitly set (e.g., in CI e2e tests)
  if (config.production && !config.test.enableTestMcpServer) {
    return;
  }

  const existing = await InternalMcpCatalogModel.findByName(
    "internal-dev-test-server",
  );
  if (existing) {
    logger.info("Test MCP server already exists in catalog, skipping");
    return;
  }

  await InternalMcpCatalogModel.create({
    name: "internal-dev-test-server",
    description:
      "Simple test MCP server for development. Has one tool that prints an env var.",
    serverType: "local",
    localConfig: {
      command: "sh",
      arguments: ["-c", testMcpServerCommand],
      transportType: "stdio",
      environment: [
        {
          key: "ARCHESTRA_TEST",
          type: "plain_text",
          promptOnInstallation: true,
          required: true,
          description: "Test value to print (any string)",
        },
      ],
    },
  });
  logger.info("Seeded test MCP server (internal-dev-test-server)");
}

/**
 * Creates team tokens for existing teams and organization
 * - Creates "Organization Token" if missing
 * - Creates team tokens for each team if missing
 */
async function seedTeamTokens(): Promise<void> {
  // Get the default organization
  const org = await OrganizationModel.getOrCreateDefaultOrganization();

  // Ensure organization token exists
  const orgToken = await TeamTokenModel.ensureOrganizationToken();
  logger.info(
    { organizationId: org.id, tokenId: orgToken.id },
    "Ensured organization token exists",
  );

  // Get all teams for this organization and ensure they have tokens
  const teams = await TeamModel.findByOrganization(org.id);
  for (const team of teams) {
    const teamToken = await TeamTokenModel.ensureTeamToken(team.id, team.name);
    logger.info(
      { teamId: team.id, teamName: team.name, tokenId: teamToken.id },
      "Ensured team token exists",
    );
  }
}

/**
 * Seeds chat API keys from environment variables.
 * For each provider with ARCHESTRA_CHAT_<PROVIDER>_API_KEY set, creates an org-wide API key
 * and syncs models from the provider.
 *
 * This enables:
 * - E2E tests: WireMock mock keys are set via env vars, models sync automatically
 * - Production: Admins can bootstrap org-wide keys via env vars
 */
async function seedChatApiKeysFromEnv(): Promise<void> {
  const org = await OrganizationModel.getOrCreateDefaultOrganization();

  for (const provider of SupportedProviders) {
    const apiKeyValue = getProviderEnvApiKey(provider);

    // Skip providers without API keys configured
    if (!apiKeyValue || apiKeyValue.trim() === "") {
      continue;
    }

    // Check if API key already exists for this provider
    const existing = await ChatApiKeyModel.findByScope(
      org.id,
      provider,
      "org_wide",
    );

    if (existing) {
      // Sync models if not already synced
      await syncModelsForApiKey(existing.id, provider, apiKeyValue);
      continue;
    }

    // Create a secret with the API key from env
    const secret = await secretManager().createSecret(
      { apiKey: apiKeyValue },
      `chatapikey-env-${provider}`,
    );

    // Create the API key
    const apiKey = await ChatApiKeyModel.create({
      organizationId: org.id,
      name: getProviderDisplayName(provider),
      provider: provider,
      secretId: secret.id,
      scope: "org_wide",
      userId: null,
      teamId: null,
    });

    logger.info(
      { provider, apiKeyId: apiKey.id },
      "Created chat API key from environment variable",
    );

    // Sync models from provider
    await syncModelsForApiKey(apiKey.id, provider, apiKeyValue);
  }
}

/**
 * Sync models for an API key.
 */
async function syncModelsForApiKey(
  apiKeyId: string,
  provider: SupportedProvider,
  apiKeyValue: string,
): Promise<void> {
  try {
    await modelSyncService.syncModelsForApiKey({
      apiKeyId,
      provider,
      apiKeyValue,
    });
    logger.info({ provider, apiKeyId }, "Synced models for API key");
  } catch (error) {
    logger.error(
      {
        provider,
        apiKeyId,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "Failed to sync models for API key",
    );
  }
}

/**
 * Get display name for a provider.
 */
function getProviderDisplayName(provider: SupportedProvider): string {
  const displayNames: Record<SupportedProvider, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    gemini: "Google",
    cerebras: "Cerebras",
    cohere: "Cohere",
    mistral: "Mistral",
    perplexity: "Perplexity AI",
    groq: "Groq",
    xai: "xAI",
    ollama: "Ollama",
    vllm: "vLLM",
    zhipuai: "ZhipuAI",
    deepseek: "DeepSeek",
    bedrock: "AWS Bedrock",
    minimax: "MiniMax",
  };
  return displayNames[provider];
}

/**
 * Migrates existing Playwright tool assignments to use dynamic credentials.
 * Static credentials break user isolation since multiple users would share
 * the same browser session. This ensures all Playwright assignments use
 * useDynamicTeamCredential=true.
 */
async function migratePlaywrightToolsToDynamicCredential(): Promise<void> {
  // Find all tool IDs belonging to the Playwright catalog
  const playwrightTools = await db
    .select({ id: schema.toolsTable.id })
    .from(schema.toolsTable)
    .where(eq(schema.toolsTable.catalogId, PLAYWRIGHT_MCP_CATALOG_ID));

  if (playwrightTools.length === 0) return;

  const playwrightToolIds = playwrightTools.map((t) => t.id);

  // Update all assignments that still use static credentials
  const result = await db
    .update(schema.agentToolsTable)
    .set({
      useDynamicTeamCredential: true,
      credentialSourceMcpServerId: null,
      executionSourceMcpServerId: null,
    })
    .where(
      and(
        inArray(schema.agentToolsTable.toolId, playwrightToolIds),
        eq(schema.agentToolsTable.useDynamicTeamCredential, false),
      ),
    );

  const count = result.rowCount ?? 0;
  if (count > 0) {
    logger.info(
      { updatedCount: count },
      "Migrated Playwright tool assignments to dynamic credentials",
    );
  }
}

async function migrateSecretsToEncrypted(): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.select().from(schema.secretsTable);
    let migrated = 0;

    for (const row of rows) {
      if (isEncryptedSecret(row.secret)) continue;

      await tx
        .update(schema.secretsTable)
        .set({ secret: encryptSecretValue(row.secret) })
        .where(eq(schema.secretsTable.id, row.id));
      migrated++;
    }

    if (migrated > 0) {
      logger.info(
        { migratedCount: migrated },
        "Migrated plaintext secrets to encrypted format",
      );
    }
  });
}

/**
 * Seeds the Policy Configuration Subagent built-in agent for fresh installs.
 * Migration 0159 creates this agent for existing organizations, but new
 * deployments (fresh DB after the migration) need it seeded here.
 */
async function seedBuiltInAgents(): Promise<void> {
  const org = await OrganizationModel.getOrCreateDefaultOrganization();

  const builtInAgents = [
    {
      builtInAgentId: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
      name: BUILT_IN_AGENT_NAMES.POLICY_CONFIG,
      description:
        "Analyzes tool metadata with AI to generate deterministic security policies for handling untrusted data",
      systemPrompt: POLICY_CONFIG_SYSTEM_PROMPT,
      builtInAgentConfig: {
        name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
        autoConfigureOnToolAssignment: false,
      } as const,
    },
    {
      builtInAgentId: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
      name: BUILT_IN_AGENT_NAMES.DUAL_LLM_MAIN,
      description:
        "Privileged built-in agent that questions quarantined tool results and writes the final safe summary",
      systemPrompt: DUAL_LLM_MAIN_SYSTEM_PROMPT,
      builtInAgentConfig: {
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
        maxRounds: 5,
      } as const,
    },
    {
      builtInAgentId: BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE,
      name: BUILT_IN_AGENT_NAMES.DUAL_LLM_QUARANTINE,
      description:
        "Quarantine built-in agent that inspects untrusted tool output and returns constrained answers only",
      systemPrompt: DUAL_LLM_QUARANTINE_SYSTEM_PROMPT,
      builtInAgentConfig: {
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE,
      } as const,
    },
  ];

  for (const builtInAgent of builtInAgents) {
    const existing = await AgentModel.getBuiltInAgent(
      builtInAgent.builtInAgentId,
      org.id,
    );
    if (existing) {
      logger.info(
        { builtInAgentId: builtInAgent.builtInAgentId },
        "Built-in agent already exists, skipping seed",
      );
      continue;
    }

    await db.insert(schema.agentsTable).values({
      organizationId: org.id,
      name: builtInAgent.name,
      agentType: "agent",
      scope: "org",
      description: builtInAgent.description,
      systemPrompt: builtInAgent.systemPrompt,
      builtInAgentConfig: builtInAgent.builtInAgentConfig,
    });
    logger.info(
      { builtInAgentId: builtInAgent.builtInAgentId },
      "Seeded built-in agent",
    );
  }
}

/**
 * Ensures all existing members have a personal default chat agent.
 * Runs on startup to backfill members created before this feature.
 */
async function ensureExistingUsersHavePersonalChatAgents(): Promise<void> {
  const membersWithoutDefault = await db
    .select({
      userId: schema.membersTable.userId,
      organizationId: schema.membersTable.organizationId,
    })
    .from(schema.membersTable)
    .where(isNull(schema.membersTable.defaultAgentId));

  if (membersWithoutDefault.length === 0) return;

  let created = 0;
  for (const member of membersWithoutDefault) {
    try {
      await AgentModel.ensurePersonalChatAgent({
        userId: member.userId,
        organizationId: member.organizationId,
      });
      created++;
    } catch (error) {
      logger.error(
        {
          err: error,
          userId: member.userId,
          organizationId: member.organizationId,
        },
        "Failed to create personal chat agent for existing member",
      );
    }
  }

  if (created > 0) {
    logger.info(
      { count: created },
      "Created personal chat agents for existing members",
    );
  }
}

export async function seedRequiredStartingData(): Promise<void> {
  ensureEncryptionKeyAvailable();
  await migrateSecretsToEncrypted();
  await seedDefaultUserAndOrg();
  // Create default agents before seeding internal agents
  await AgentModel.getMCPGatewayOrCreateDefault();
  await AgentModel.getLLMProxyOrCreateDefault();
  await seedBuiltInAgents();
  await seedArchestraCatalogAndTools();
  await seedPlaywrightCatalog();
  await migratePlaywrightToolsToDynamicCredential();
  await seedTestMcpServer();
  await seedTeamTokens();
  await seedChatApiKeysFromEnv();
  // Ensure all existing members have a personal default chat agent
  await ensureExistingUsersHavePersonalChatAgents();
  // Clean up orphaned MCP HTTP sessions (older than 24h)
  await McpHttpSessionModel.deleteExpired();
}
