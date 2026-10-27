import { randomUUID } from "node:crypto";
import { CHANNEL_INSTRUCTIONS_MAX_LENGTH, RouteId } from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import {
  getJiraProject,
  JiraApiRequestError,
  jiraChannelId,
  listJiraProjects,
  verifyJiraBotIdentity,
} from "@/agents/chatops/jira-provider";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { hasPermission } from "@/auth";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import config from "@/config";
import AgentModel from "@/models/agent";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import ChatOpsConfigModel from "@/models/chatops-config";
import MemberModel from "@/models/member";
import ServiceAccountModel from "@/models/service-account";
import UserModel from "@/models/user";
import { ngrokTunnelManager } from "@/ngrok-tunnel-manager";
import { assertMessagingChannelAllowed } from "@/services/integration-overrides";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError, constructResponseSchema } from "@/types";
import { ChatOpsChannelBindingResponseSchema } from "@/types/chatops-channel-binding";
import {
  type JiraBotConfig,
  JiraBotViewSchema,
  JiraChatOpsConfigViewSchema,
  type JiraDbConfig,
  JiraIngressModeSchema,
  JiraProjectSchema,
  normalizeJiraSiteUrl,
} from "@/types/chatops-jira";

const jiraChatOpsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/chatops/jira/config",
    {
      schema: {
        operationId: RouteId.GetJiraChatOpsConfig,
        tags: ["ChatOps"],
        response: constructResponseSchema(JiraChatOpsConfigViewSchema),
      },
    },
    async (request) => {
      await requireSettingsPermission(request, "read");
      return configView(await getConfig(request.organizationId));
    },
  );

  fastify.put(
    "/api/chatops/jira/config",
    {
      schema: {
        operationId: RouteId.UpdateJiraChatOpsConfig,
        tags: ["ChatOps"],
        body: z
          .object({
            enabled: z.boolean(),
            siteUrl: z.string().trim().max(512),
            ingressMode: JiraIngressModeSchema,
            webhookSecret: z.string().min(16).max(4096).optional(),
          })
          .strict(),
        response: constructResponseSchema(JiraChatOpsConfigViewSchema),
      },
    },
    async (request) => {
      await requireSettingsPermission(request, "update");
      await assertMessagingChannelAllowed({
        organizationId: request.organizationId,
        channel: "jira",
      });
      let siteUrl: string;
      try {
        siteUrl = normalizeJiraSiteUrl(request.body.siteUrl);
      } catch {
        throw new ApiError(
          400,
          "Use an HTTPS Jira Cloud site URL such as https://example.atlassian.net",
        );
      }
      let secretChanged = false;
      const saved = await ChatOpsConfigModel.updateJiraConfig((current) => {
        assertConfigOrganization(current, request.organizationId);
        if (current?.bots.length && current.siteUrl !== siteUrl) {
          throw new ApiError(
            409,
            "Remove the connected Jira bots before changing the site",
          );
        }
        const webhookSecret =
          request.body.webhookSecret ?? current?.webhookSecret;
        if (
          (!webhookSecret || webhookSecret.length < 16) &&
          request.body.ingressMode !== "poll"
        )
          throw new ApiError(400, "A webhook secret is required");
        secretChanged = current?.webhookSecret !== webhookSecret;
        if (
          current &&
          !secretChanged &&
          current.siteUrl === siteUrl &&
          current.enabled === request.body.enabled &&
          current.ingressMode === request.body.ingressMode
        )
          request.auditSkip = true;
        return {
          id: current?.id ?? randomUUID(),
          organizationId: request.organizationId,
          enabled: request.body.enabled,
          siteUrl,
          ingressMode: request.body.ingressMode,
          webhookSecret: webhookSecret ?? "",
          ...(request.body.ingressMode === "poll" && {
            pollStartedAt:
              current?.ingressMode === "poll" && current.enabled
                ? (current.pollStartedAt ??
                  current.pollSince ??
                  new Date().toISOString())
                : new Date().toISOString(),
            pollSince:
              current?.ingressMode === "poll" && current.enabled
                ? (current.pollSince ?? new Date().toISOString())
                : new Date().toISOString(),
          }),
          bots: current?.bots ?? [],
        };
      });
      if (secretChanged) {
        request.auditAfter = {
          ...(await ChatOpsConfigModel.getJiraSnapshotForAudit(
            request.organizationId,
          )),
          webhookCredentialUpdated: true,
        };
      }
      await chatOpsManager.reloadJiraProviders();
      return configView(saved);
    },
  );

  fastify.post(
    "/api/chatops/jira/bots",
    {
      schema: {
        operationId: RouteId.CreateJiraChatOpsBot,
        tags: ["ChatOps"],
        body: z
          .object({
            agentId: z.string().uuid(),
            email: z.string().trim().email().max(320),
            apiToken: z.string().min(1).max(4096),
            tokenType: z.enum(["classic", "scoped"]).default("classic"),
            fallbackServiceAccountId: z.string().uuid().optional(),
            fallbackReviewerUserId: z.string().min(1).max(256).optional(),
          })
          .strict(),
        response: constructResponseSchema(JiraBotViewSchema),
      },
    },
    async (request) => {
      await requireSettingsPermission(request, "update");
      await assertMessagingChannelAllowed({
        organizationId: request.organizationId,
        channel: "jira",
      });
      await requireAgentManagement({ request, agentId: request.body.agentId });
      await validateFallback({ request, ...request.body });
      const current = await requireConfig(request.organizationId);
      let identity: Awaited<ReturnType<typeof verifyJiraBotIdentity>>;
      try {
        identity = await verifyJiraBotIdentity({
          siteUrl: current.siteUrl,
          email: request.body.email,
          apiToken: request.body.apiToken,
          tokenType: request.body.tokenType,
        });
      } catch (error) {
        const detail =
          error instanceof JiraApiRequestError
            ? ` Jira returned HTTP ${error.status}.`
            : error instanceof z.ZodError
              ? " Jira returned an unexpected identity response."
              : error instanceof Error &&
                  [
                    "Could not resolve this Jira Cloud site's identifier.",
                    "The Jira bot account is inactive.",
                  ].includes(error.message)
                ? ` ${error.message}`
                : error instanceof TypeError
                  ? " The request could not reach Jira."
                  : "";
        throw new ApiError(
          400,
          `Could not verify the Jira bot.${detail} Check its site, email, token, and Jira access.`,
        );
      }
      const bot: JiraBotConfig = {
        id: randomUUID(),
        agentId: request.body.agentId,
        email: request.body.email,
        apiToken: request.body.apiToken,
        accountId: identity.accountId,
        displayName: identity.displayName,
        ...(identity.cloudId && { cloudId: identity.cloudId }),
        enabled: true,
        ...(request.body.fallbackServiceAccountId && {
          fallbackServiceAccountId: request.body.fallbackServiceAccountId,
        }),
        ...(request.body.fallbackReviewerUserId && {
          fallbackReviewerUserId: request.body.fallbackReviewerUserId,
        }),
      };
      await ChatOpsConfigModel.updateJiraConfig((latest) => {
        assertConfigOrganization(latest, request.organizationId);
        if (
          !latest ||
          latest.id !== current.id ||
          latest.siteUrl !== current.siteUrl
        ) {
          throw new ApiError(
            409,
            "Jira configuration changed; verify the bot again",
          );
        }
        if (
          latest.bots.some(
            (existing) =>
              existing.accountId === bot.accountId ||
              existing.agentId === bot.agentId,
          )
        ) {
          throw new ApiError(
            409,
            `Each Jira account and ${archestraMcpBranding.appName} agent can only be connected once`,
          );
        }
        return { ...latest, bots: [...latest.bots, bot] };
      });
      await chatOpsManager.reloadJiraProviders();
      return botView(bot);
    },
  );

  fastify.patch(
    "/api/chatops/jira/bots/:botId",
    {
      schema: {
        operationId: RouteId.UpdateJiraChatOpsBot,
        tags: ["ChatOps"],
        params: BotParamsSchema,
        body: z
          .object({
            enabled: z.boolean().optional(),
            fallbackServiceAccountId: z.string().uuid().nullable().optional(),
            fallbackReviewerUserId: z
              .string()
              .min(1)
              .max(256)
              .nullable()
              .optional(),
          })
          .strict(),
        response: constructResponseSchema(JiraBotViewSchema),
      },
    },
    async (request) => {
      await requireSettingsPermission(request, "update");
      if (request.body.enabled)
        await assertMessagingChannelAllowed({
          organizationId: request.organizationId,
          channel: "jira",
        });
      const { bot } = await requireBot({
        organizationId: request.organizationId,
        botId: request.params.botId,
      });
      await requireAgentManagement({ request, agentId: bot.agentId });
      const fallbackServiceAccountId =
        request.body.fallbackServiceAccountId === null
          ? undefined
          : (request.body.fallbackServiceAccountId ??
            bot.fallbackServiceAccountId);
      const fallbackReviewerUserId =
        request.body.fallbackReviewerUserId === null
          ? undefined
          : (request.body.fallbackReviewerUserId ?? bot.fallbackReviewerUserId);
      await validateFallback({
        request,
        agentId: bot.agentId,
        fallbackServiceAccountId,
        fallbackReviewerUserId,
      });
      let updated = bot;
      await ChatOpsConfigModel.updateJiraConfig((current) => {
        assertConfigOrganization(current, request.organizationId);
        const latest = current?.bots.find((item) => item.id === bot.id);
        if (
          !current ||
          !latest ||
          JSON.stringify(latest) !== JSON.stringify(bot)
        ) {
          throw new ApiError(
            409,
            "The Jira bot changed; refresh before saving",
          );
        }
        updated = {
          ...latest,
          enabled: request.body.enabled ?? latest.enabled,
          fallbackServiceAccountId,
          fallbackReviewerUserId,
        };
        if (
          JSON.stringify(botView(updated)) === JSON.stringify(botView(latest))
        )
          request.auditSkip = true;
        return {
          ...current,
          bots: current.bots.map((item) =>
            item.id === bot.id ? updated : item,
          ),
        };
      });
      await chatOpsManager.reloadJiraProviders();
      return botView(updated);
    },
  );

  fastify.delete(
    "/api/chatops/jira/bots/:botId",
    {
      schema: {
        operationId: RouteId.DeleteJiraChatOpsBot,
        tags: ["ChatOps"],
        params: BotParamsSchema,
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request) => {
      await requireSettingsPermission(request, "update");
      const { config: current, bot } = await requireBot({
        organizationId: request.organizationId,
        botId: request.params.botId,
      });
      await requireAgentManagement({ request, agentId: bot.agentId });
      await ChatOpsConfigModel.updateJiraConfig((latest) => {
        assertConfigOrganization(latest, request.organizationId);
        if (!latest) throw new ApiError(404, "Jira is not configured");
        if (!latest.bots.some((item) => item.id === bot.id))
          throw new ApiError(409, "The Jira bot has already been removed");
        return {
          ...latest,
          bots: latest.bots.filter((item) => item.id !== bot.id),
        };
      });
      await chatOpsManager.reloadJiraProviders();
      const bindings = await ChatOpsChannelBindingModel.findByOrganization(
        request.organizationId,
      );
      for (const binding of bindings) {
        if (
          binding.provider === "jira" &&
          binding.workspaceId === current.id &&
          binding.channelId.startsWith(`${bot.id}:`)
        ) {
          await ChatOpsChannelBindingModel.deleteByIdAndOrganization(
            binding.id,
            request.organizationId,
          );
        }
      }
      return { success: true };
    },
  );

  fastify.get(
    "/api/chatops/jira/bots/:botId/projects",
    {
      schema: {
        operationId: RouteId.ListJiraChatOpsProjects,
        tags: ["ChatOps"],
        params: BotParamsSchema,
        response: constructResponseSchema(z.array(JiraProjectSchema)),
      },
    },
    async (request) => {
      await requireSettingsPermission(request, "read");
      const connected = await requireBot({
        organizationId: request.organizationId,
        botId: request.params.botId,
      });
      await requireAgentManagement({ request, agentId: connected.bot.agentId });
      try {
        return await listJiraProjects(connected);
      } catch {
        throw new ApiError(
          400,
          "Could not list projects with this Jira bot's credentials",
        );
      }
    },
  );

  fastify.post(
    "/api/chatops/jira/bots/:botId/bindings",
    {
      schema: {
        operationId: RouteId.CreateJiraChatOpsBinding,
        tags: ["ChatOps"],
        params: BotParamsSchema,
        body: z
          .object({
            projectId: z.string().regex(/^\d+$/).max(256),
            instructions: z
              .string()
              .max(CHANNEL_INSTRUCTIONS_MAX_LENGTH)
              .optional(),
          })
          .strict(),
        response: constructResponseSchema(ChatOpsChannelBindingResponseSchema),
      },
    },
    async (request) => {
      await requireSettingsPermission(request, "update");
      await assertMessagingChannelAllowed({
        organizationId: request.organizationId,
        channel: "jira",
      });
      const connected = await requireBot({
        organizationId: request.organizationId,
        botId: request.params.botId,
      });
      await requireAgentManagement({ request, agentId: connected.bot.agentId });
      let project: Awaited<ReturnType<typeof getJiraProject>>;
      try {
        project = await getJiraProject({
          ...connected,
          projectId: request.body.projectId,
        });
      } catch {
        throw new ApiError(400, "This Jira bot cannot access that project");
      }
      const latest = await requireBot({
        organizationId: request.organizationId,
        botId: request.params.botId,
      });
      if (JSON.stringify(latest) !== JSON.stringify(connected)) {
        throw new ApiError(
          409,
          "The Jira configuration changed; refresh before binding",
        );
      }
      const channelId = jiraChannelId(connected.bot.id, project.id);
      const existingBinding = await ChatOpsChannelBindingModel.findByChannel({
        provider: "jira",
        workspaceId: connected.config.id,
        channelId,
      });
      if (
        existingBinding &&
        existingBinding.organizationId !== request.organizationId
      )
        throw new ApiError(404, "Binding not found");
      const binding = await ChatOpsChannelBindingModel.upsertByChannel({
        organizationId: request.organizationId,
        provider: "jira",
        workspaceId: connected.config.id,
        workspaceName: connected.config.siteUrl,
        channelId,
        channelName: `${project.key} · ${project.name}`,
        agentId: connected.bot.agentId,
        isDm: false,
      });
      const updated =
        request.body.instructions !== undefined
          ? await ChatOpsChannelBindingModel.updateByIdAndOrganization({
              id: binding.id,
              organizationId: request.organizationId,
              input: {
                channelInstructions: request.body.instructions.trim() || null,
              },
            })
          : binding;
      const result = updated ?? binding;
      if (
        request.auditBefore &&
        JSON.stringify(request.auditBefore) ===
          JSON.stringify(
            await ChatOpsChannelBindingModel.findBindingsFingerprintForOrganization(
              request.organizationId,
            ),
          )
      )
        request.auditSkip = true;
      return {
        ...result,
        createdAt: result.createdAt.toISOString(),
        updatedAt: result.updatedAt.toISOString(),
      };
    },
  );
};

export default jiraChatOpsRoutes;

// === Internal helpers ===

const BotParamsSchema = z.object({ botId: z.string().uuid() });

async function requireSettingsPermission(
  request: FastifyRequest,
  action: "read" | "update",
): Promise<void> {
  const permission = await hasPermission(
    { organizationSettings: [action] },
    request.headers,
    undefined,
    { userId: request.user.id, organizationId: request.organizationId },
  );
  if (!permission.success)
    throw new ApiError(
      403,
      "You do not have permission to manage Jira messaging settings",
    );
}

function assertConfigOrganization(
  value: JiraDbConfig | null,
  organizationId: string,
): void {
  if (value && value.organizationId !== organizationId)
    throw new ApiError(404, "Jira configuration not found");
}

async function getConfig(organizationId: string): Promise<JiraDbConfig | null> {
  const value = await ChatOpsConfigModel.getJiraConfig();
  assertConfigOrganization(value, organizationId);
  return value;
}

async function requireConfig(organizationId: string): Promise<JiraDbConfig> {
  const value = await getConfig(organizationId);
  if (!value) throw new ApiError(404, "Configure the Jira site first");
  return value;
}

async function requireBot(params: {
  organizationId: string;
  botId: string;
}): Promise<{ config: JiraDbConfig; bot: JiraBotConfig }> {
  const value = await requireConfig(params.organizationId);
  const bot = value.bots.find((item) => item.id === params.botId);
  if (!bot) throw new ApiError(404, "Jira bot not found");
  return { config: value, bot };
}

function botView(bot: JiraBotConfig): z.infer<typeof JiraBotViewSchema> {
  const {
    apiToken,
    fallbackServiceAccountId,
    fallbackReviewerUserId,
    ...rest
  } = bot;
  return {
    ...rest,
    hasApiToken: Boolean(apiToken),
    fallbackServiceAccountId: fallbackServiceAccountId ?? null,
    fallbackReviewerUserId: fallbackReviewerUserId ?? null,
  };
}

function configView(
  value: JiraDbConfig | null,
): z.infer<typeof JiraChatOpsConfigViewSchema> {
  const domain = ngrokTunnelManager.getPublicDomain();
  const base =
    config.chatops.webhookBaseUrl ??
    (domain
      ? `https://${domain.replace(/^https?:\/\//, "")}`
      : config.frontendBaseUrl);
  return {
    id: value?.id ?? null,
    enabled: value?.enabled ?? false,
    siteUrl: value?.siteUrl ?? "",
    ingressMode: value?.ingressMode ?? "hmac",
    hasWebhookSecret: Boolean(value?.webhookSecret),
    webhookUrl: value
      ? `${base.replace(/\/$/, "")}/api/webhooks/chatops/jira/${value.id}`
      : null,
    bots: value?.bots.map(botView) ?? [],
    pollingSupported: true,
  };
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
async function requireAgentManagement(params: {
  request: FastifyRequest;
  agentId: string;
}): Promise<void> {
  const agent = await AgentModel.findById(params.agentId);
  if (
    !agent ||
    agent.organizationId !== params.request.organizationId ||
    agent.agentType !== "agent"
  ) {
    throw new ApiError(404, "Agent not found");
  }
  for (const action of ["use", "manage-permissions"] as const) {
    await ResourcePermissions.require({
      organizationId: params.request.organizationId,
      userId: params.request.user.id,
      resource: "agent",
      scope: agent.id,
      action,
    });
  }
}

async function validateFallback(params: {
  request: FastifyRequest;
  agentId: string;
  fallbackServiceAccountId?: string;
  fallbackReviewerUserId?: string;
}): Promise<void> {
  const { fallbackServiceAccountId, fallbackReviewerUserId } = params;
  if (Boolean(fallbackServiceAccountId) !== Boolean(fallbackReviewerUserId)) {
    throw new ApiError(
      400,
      "Choose both a fallback service account and a verified human reviewer, or neither",
    );
  }
  if (!fallbackServiceAccountId || !fallbackReviewerUserId) return;
  const organizationId = params.request.organizationId;
  const service = await ServiceAccountModel.findAuthContext(
    fallbackServiceAccountId,
    organizationId,
  );
  const [reviewer, member] = await Promise.all([
    UserModel.getById(fallbackReviewerUserId),
    MemberModel.getByUserId(fallbackReviewerUserId, organizationId),
  ]);
  if (!service || service.disabled)
    throw new ApiError(
      400,
      "Select an enabled service account in this organization",
    );
  if (!reviewer || !member || !reviewer.emailVerified || reviewer.banned) {
    throw new ApiError(
      400,
      "Select an active reviewer with a verified email in this organization",
    );
  }
  await ResourcePermissions.require({
    organizationId,
    userId: params.request.user.id,
    resource: "serviceAccount",
    scope: fallbackServiceAccountId,
    action: "use",
  });
  for (const userId of [
    serviceAccountUserId(fallbackServiceAccountId),
    fallbackReviewerUserId,
  ]) {
    await ResourcePermissions.require({
      organizationId,
      userId,
      resource: "agent",
      scope: params.agentId,
      action: "use",
    });
  }
}
// SPDX-SnippetEnd
