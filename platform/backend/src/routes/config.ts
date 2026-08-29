import {
  ContextualRetrievalModeSchema,
  RouteId,
  SupportedProvidersSchema,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getEmailProviderInfo } from "@/agents/incoming-email";
import { anthropicWorkloadIdentity } from "@/clients/anthropic-workload-identity";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import { isBedrockIamAuthEnabled } from "@/clients/bedrock-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import config from "@/config";
import { isLockedChatEnabled } from "@/content-encryption/locked-chat";
import { enterpriseTier } from "@/enterprise-tier";
import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// biome-ignore lint/style/noRestrictedImports: runtime-gated EE model import
import { isIdleHibernationOffered } from "@/k8s/mcp-server-runtime/hibernation.ee";
// SPDX-SnippetEnd
import {
  getGoogleDriveOAuthRedirectUri,
  isGoogleDriveOAuthConfigured,
} from "@/knowledge-base/connectors/gdrive/gdrive-oauth";
import logger from "@/logging";
import { OrganizationModel } from "@/models";
import { ngrokTunnelManager } from "@/ngrok-tunnel-manager";
import { getByosVaultKvVersion, isByosEnabled } from "@/secrets-manager";
import { isAnyRunnerBackendEnabled } from "@/services/runners/backends";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import { EmailProviderTypeSchema } from "@/types";
import { PUBLIC_CONFIG_PATH } from "./route-paths";

export const publicConfigRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    PUBLIC_CONFIG_PATH,
    {
      schema: {
        operationId: RouteId.GetPublicConfig,
        description: "Get public config",
        tags: ["Config"],
        response: {
          200: PublicConfigResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      return reply.send(await getPublicConfigResponse());
    },
  );
};

const configRoutes: FastifyPluginAsyncZod = async (fastify) => {
  await fastify.register(publicConfigRoutes);

  fastify.get(
    "/api/config",
    {
      schema: {
        operationId: RouteId.GetConfig,
        description: "Get platform configuration and feature flags",
        tags: ["Config"],
        response: {
          200: z.strictObject({
            enterpriseFeatures: z.strictObject({
              core: z.boolean(),
              knowledgeBase: z.boolean(),
              fullWhiteLabeling: z.boolean(),
            }),
            smallTeamTier: z.strictObject({
              threshold: z.number(),
              userCount: z.number(),
              smallTeam: z.boolean(),
              envFlag: z.boolean(),
              communicate: z.boolean(),
            }),
            features: z.strictObject({
              betaEnabled: z.boolean(),
              orchestratorK8sRuntime: z.boolean(),
              // SPDX-SnippetBegin
              // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
              // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
              // Deployment-level gate for MCP idle hibernation (the beta flag
              // AND the operator kill switch); the licence and the
              // organization toggle sit behind it.
              mcpIdleHibernationBetaEnabled: z.boolean(),
              /** BETA: MCP registry attention and alert dismissal surfaces. */
              mcpServerAlertingEnabled: z.boolean(),
              // SPDX-SnippetEnd
              sandbox: z.boolean(),
              /**
               * Delegated Agent tasks in dedicated deployments.
               * True only when the feature is switched on AND the Kubernetes
               * runtime is configured — the UI must not offer to start a
               * deployment nothing can schedule.
               */
              agentBackgroundExecution: z.boolean(),
              agentBackgroundExecutionBaseImage: z.string(),
              /** Operator-owned defaults and health for the execution backend. */
              agentBackgroundExecutionBackend: z
                .object({
                  name: z.literal("kubernetes"),
                  available: z.boolean(),
                  defaultImage: z.string(),
                  defaultTtlHours: z.number(),
                  defaultIdleTimeoutMinutes: z.number(),
                  allowPrivileged: z.boolean(),
                  resources: z.object({
                    cpuRequest: z.string(),
                    memoryRequest: z.string(),
                    memoryLimit: z.string(),
                  }),
                })
                .nullable(),
              plugins: z.boolean(),
              // Max size of a file the sandbox can stage. The chat composer caps
              // sandbox-routed uploads at this instead of guessing.
              sandboxArtifactBytesLimit: z.number(),
              // Max size of a chat upload the conversation can store (Files
              // panel). Bounds the composer's file picker and its per-file
              // policy; independent of what the sandbox can stage.
              chatAttachmentStorageBytesLimit: z.number(),
              // Request body ceiling. A turn's attachments travel base64-encoded
              // in one request, so the composer needs this to stop a send that
              // the body parser would reject with an opaque 413.
              apiBodyLimitBytes: z.number(),
              byosEnabled: z.boolean(),
              byosVaultKvVersion: z.enum(["1", "2"]).nullable(),
              azureOpenAiEntraIdEnabled: z.boolean(),
              anthropicWifEnabled: z.boolean(),
              bedrockIamAuthEnabled: z.boolean(),
              geminiVertexAiEnabled: z.boolean(),
              incomingEmail: z.object({
                enabled: z.boolean(),
                provider: EmailProviderTypeSchema.optional(),
                displayName: z.string().optional(),
                emailDomain: z.string().optional(),
              }),
              mcpServerBaseImage: z.string(),
              orchestratorK8sNamespace: z.string(),
              environmentNamespaces: z.array(z.string()),
              isQuickstart: z.boolean(),
              ngrokDomain: z.string(),
              virtualKeyDefaultExpirationSeconds: z.number(),
              mcpSandboxDomain: z.string().nullable(),
              maintenanceMode: z.string().nullable(),
              chatSecretScanEnabled: z.boolean(),
              lockedChatEnabled: z.boolean(),
              agentHooksEnabled: z.boolean(),
              chatopsTelegramEnabled: z.boolean(),
              /** BETA: auto-sync-permissions connector visibility and its Permissions tab UI. */
              kbAutoSyncPermissionsEnabled: z.boolean(),
              kbMfilesConnectorEnabled: z.boolean(),
              kbMfilesOauthEnabled: z.boolean(),
              /**
               * The BM25 tuning constants an organization inherits until it
               * sets its own in Knowledge settings; the settings tab shows them
               * as the effective values wherever the organization has not.
               */
              kbBm25DefaultK1: z.number(),
              kbBm25DefaultB: z.number(),
              /**
               * Effective fallback for organizations that have not selected a
               * contextual retrieval mode in Knowledge settings.
               */
              kbContextualRetrievalDefaultMode: ContextualRetrievalModeSchema,
              /**
               * Individual ("connect my own Drive") auth for the Google Drive
               * knowledge connector. `redirectUri` is the exact string that
               * has to be registered on the Google OAuth client, so the setup
               * UI can state it instead of leaving an admin to work out how
               * this deployment composes its own URL.
               */
              kbGoogleDriveOAuth: z.object({
                configured: z.boolean(),
                redirectUri: z.string(),
              }),
              /**
               * BETA: publish local Skills over gateways and project Skills
               * discovered from installed MCP servers.
               */
              mcpGatewaySkillsEnabled: z.boolean(),
              /** App session recording (record/replay/download app demos). */
              hackathonRecorderEnabled: z.boolean(),
              /**
               * The offline video export is offered. Off by default: a render
               * drives a headless browser for as long as the cut runs, and the
               * gallery submission does not depend on it.
               */
              hackathonVideoDownloadEnabled: z.boolean(),
              /**
               * The longest final cut this deployment accepts, in ms. Every
               * length surface reads it from here, so the number the author is
               * shown is always the number the checks enforce.
               */
              hackathonMaxFinalCutMs: z.number().int().positive(),
              /**
               * The public App Gallery repository shared recordings are
               * submitted to, or null when this deployment does not offer
               * sharing. The frontend files the PR against this repository
               * directly on api.github.com.
               */
              hackathonGalleryRepo: z
                .object({ owner: z.string(), name: z.string() })
                .nullable(),
            }),
            providerBaseUrls: z.record(
              SupportedProvidersSchema,
              z.string().nullable(),
            ),
          }),
        },
      },
    },
    async (_request, reply) => {
      const tier = enterpriseTier.getState();

      return reply.send({
        enterpriseFeatures: {
          core: tier.coreActive,
          knowledgeBase: tier.knowledgeBaseActive,
          fullWhiteLabeling: config.enterpriseFeatures.fullWhiteLabeling,
        },
        smallTeamTier: {
          threshold: tier.threshold,
          userCount: tier.userCount,
          smallTeam: tier.smallTeam,
          envFlag: tier.envFlag,
          communicate: tier.communicate,
        },
        features: {
          betaEnabled: config.beta,
          orchestratorK8sRuntime: McpServerRuntimeManager.isEnabled,
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          // The whole deployment-level gate, not the beta flag alone: an
          // operator's hard kill switch must take the settings toggle and the
          // per-server control with it, or the UI renders an operational
          // feature nothing behind it will ever run.
          mcpIdleHibernationBetaEnabled: isIdleHibernationOffered(),
          mcpServerAlertingEnabled: config.mcpServer.alertingEnabled,
          // SPDX-SnippetEnd
          sandbox: skillSandboxRuntimeService.isEnabled,
          // The same predicate the routes gate on, so the UI can never offer
          // a feature whose endpoints answer 404.
          agentBackgroundExecution: isAnyRunnerBackendEnabled(),
          agentBackgroundExecutionBaseImage:
            config.agentBackgroundExecution.defaultImage,
          agentBackgroundExecutionBackend: config.agentBackgroundExecution
            .enabled
            ? {
                name: "kubernetes" as const,
                available: isAnyRunnerBackendEnabled(),
                defaultImage: config.agentBackgroundExecution.defaultImage,
                defaultTtlHours:
                  config.agentBackgroundExecution.defaultTtlHours,
                defaultIdleTimeoutMinutes:
                  config.agentBackgroundExecution.defaultIdleTimeoutMinutes,
                allowPrivileged:
                  config.agentBackgroundExecution.allowPrivileged,
                resources: config.agentBackgroundExecution.resources,
              }
            : null,
          plugins: config.plugins.enabled,
          sandboxArtifactBytesLimit: config.skillsSandbox.artifactBytesLimit,
          chatAttachmentStorageBytesLimit:
            config.chat.attachmentStorageBytesLimit,
          apiBodyLimitBytes: config.api.bodyLimit,
          byosEnabled: isByosEnabled(),
          byosVaultKvVersion: getByosVaultKvVersion(),
          azureOpenAiEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
          anthropicWifEnabled: anthropicWorkloadIdentity.isEnabled(),
          bedrockIamAuthEnabled: isBedrockIamAuthEnabled(),
          geminiVertexAiEnabled: isVertexAiEnabled(),
          incomingEmail: getEmailProviderInfo(),
          mcpServerBaseImage: config.orchestrator.mcpServerBaseImage,
          orchestratorK8sNamespace: config.orchestrator.kubernetes.namespace,
          environmentNamespaces:
            config.orchestrator.kubernetes.environmentNamespaces,
          isQuickstart: config.isQuickstart,
          ngrokDomain: ngrokTunnelManager.getPublicDomain(),
          virtualKeyDefaultExpirationSeconds:
            config.llmProxy.virtualKeyDefaultExpirationSeconds,
          mcpSandboxDomain: config.mcpSandbox.domain,
          maintenanceMode: config.maintenanceMode,
          chatSecretScanEnabled: config.chat.secretScanEnabled,
          lockedChatEnabled: isLockedChatEnabled(),
          agentHooksEnabled: config.hooks.enabled,
          chatopsTelegramEnabled: config.chatops.telegramEnabled,
          kbAutoSyncPermissionsEnabled: config.kb.autoSyncPermissionsEnabled,
          kbMfilesConnectorEnabled: config.kb.mfilesConnectorEnabled,
          kbMfilesOauthEnabled: config.kb.mfilesOauthEnabled,
          kbBm25DefaultK1: config.kb.bm25K1,
          kbBm25DefaultB: config.kb.bm25B,
          kbContextualRetrievalDefaultMode: config.kb.contextualRetrievalEnabled
            ? "document"
            : "disabled",
          kbGoogleDriveOAuth: {
            configured: isGoogleDriveOAuthConfigured(),
            redirectUri: getGoogleDriveOAuthRedirectUri(),
          },
          mcpGatewaySkillsEnabled: config.mcpGateway.skillsEnabled,
          hackathonRecorderEnabled: config.hackathonRecorder.enabled,
          hackathonVideoDownloadEnabled:
            config.hackathonRecorder.videoDownloadEnabled,
          hackathonMaxFinalCutMs: config.hackathonRecorder.maxFinalCutMs,
          hackathonGalleryRepo:
            (config.hackathonRecorder.gallery.githubClientId &&
              config.hackathonRecorder.gallery.repo) ||
            null,
        },
        providerBaseUrls: {
          openai: config.llm.openai.baseUrl || null,
          openrouter: config.llm.openrouter.baseUrl || null,
          anthropic: config.llm.anthropic.baseUrl || null,
          gemini: config.llm.gemini.baseUrl || null,
          bedrock: config.llm.bedrock.baseUrl || null,
          cohere: config.llm.cohere.baseUrl || null,
          voyage: config.llm.voyage.baseUrl || null,
          cerebras: config.llm.cerebras.baseUrl || null,
          mistral: config.llm.mistral.baseUrl || null,
          perplexity: config.llm.perplexity.baseUrl || null,
          groq: config.llm.groq.baseUrl || null,
          xai: config.llm.xai.baseUrl || null,
          vllm: config.llm.vllm.baseUrl || null,
          ollama: config.llm.ollama.baseUrl || null,
          "ollama-native": config.llm["ollama-native"].baseUrl || null,
          zhipuai: config.llm.zhipuai.baseUrl || null,
          minimax: config.llm.minimax.baseUrl || null,
          deepseek: config.llm.deepseek.baseUrl || null,
          archestra: config.llm.archestra.baseUrl || null,
          kimi: config.llm.kimi.baseUrl || null,
          "github-copilot": config.llm["github-copilot"].baseUrl || null,
          "microsoft-365-copilot":
            config.llm["microsoft-365-copilot"].baseUrl || null,
          azure: config.llm.azure.baseUrl || null,
        },
      });
    },
  );
};

export default configRoutes;

const PublicConfigResponseSchema = z.strictObject({
  disableBasicAuth: z.boolean(),
  disableInvitations: z.boolean(),
  disableImpersonation: z.boolean(),
  // Developer-only: when true, the login page auto-mints a session via
  // POST /api/auth/dev-auto-login instead of showing the sign-in form. Always
  // false in production (the driving env var is ignored there).
  devAutoLoginEnabled: z.boolean(),
  maintenanceMode: z.string().nullable(),
  // Instance-wide banner (markdown) rendered at the top of the UI. Exposed
  // pre-auth so operators can label an instance on the login screen too.
  siteNotificationMessage: z.string().nullable(),
  // Effective enterprise core flag (env var OR small-team free tier). Exposed
  // pre-auth so the login screen can decide whether to render the SSO picker.
  enterpriseCoreActive: z.boolean(),
  // Dedicated sandbox origin (<hash>.{domain}) for MCP App iframes. Not a
  // secret — it already appears in every app iframe URL and the sandbox CSP
  // frame-ancestors header. Exposed pre-auth for the offline app-recording
  // video renderer, which drives the replay page with no session and must
  // still frame the sandbox at its real cross-origin rather than falling back
  // to the frontend origin (which the backend refuses with a 403 host check).
  mcpSandboxDomain: z.string().nullable(),
  analytics: z.strictObject({
    enabled: z.boolean(),
    instanceId: z.string().uuid().nullable(),
    posthog: z.strictObject({
      key: z.string(),
      host: z.string(),
    }),
  }),
  // Product-usage telemetry (RUM): when enabled, the frontend loads its RUM
  // module and posts usage events to /api/rum/events for OTLP export.
  rum: z.strictObject({
    enabled: z.boolean(),
    sampleRate: z.number(),
  }),
});

let cachedAnalyticsInstanceId: string | null = null;
let pendingAnalyticsInstanceId: Promise<string | null> | null = null;
let hasLoggedAnalyticsInstanceIdError = false;

async function getPublicConfigResponse(): Promise<
  z.infer<typeof PublicConfigResponseSchema>
> {
  return {
    disableBasicAuth: config.auth.disableBasicAuth,
    disableInvitations: config.auth.disableInvitations,
    disableImpersonation: config.auth.disableImpersonation,
    devAutoLoginEnabled: !!config.auth.devAutoAuthenticateEmail,
    maintenanceMode: config.maintenanceMode,
    siteNotificationMessage: config.siteNotificationMessage,
    enterpriseCoreActive: enterpriseTier.isCoreActive(),
    mcpSandboxDomain: config.mcpSandbox.domain,
    analytics: {
      enabled: config.analytics.enabled,
      instanceId: await getAnalyticsInstanceId(),
      posthog: config.analytics.posthog,
    },
    rum: {
      enabled: config.observability.rum.enabled,
      sampleRate: config.observability.rum.sampleRate,
    },
  };
}

async function getAnalyticsInstanceId(): Promise<string | null> {
  if (config.maintenanceMode) return null;
  if (cachedAnalyticsInstanceId) return cachedAnalyticsInstanceId;

  pendingAnalyticsInstanceId ??= loadAnalyticsInstanceId();
  try {
    return await pendingAnalyticsInstanceId;
  } finally {
    pendingAnalyticsInstanceId = null;
  }
}

async function loadAnalyticsInstanceId(): Promise<string | null> {
  try {
    const instanceId = (await OrganizationModel.getAnalyticsState())
      .analyticsInstanceId;
    cachedAnalyticsInstanceId = instanceId;
    hasLoggedAnalyticsInstanceIdError = false;
    return instanceId;
  } catch (error) {
    if (!hasLoggedAnalyticsInstanceIdError) {
      logger.warn(
        { err: error },
        "Failed to load analytics instance ID for public config",
      );
      hasLoggedAnalyticsInstanceIdError = true;
    }
    return null;
  }
}
