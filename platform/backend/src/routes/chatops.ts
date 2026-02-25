import { RouteId } from "@shared";
import { ActivityTypes, TeamsInfo, TurnContext } from "botbuilder";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import {
  CHATOPS_COMMANDS,
  CHATOPS_RATE_LIMIT,
  SLACK_DEFAULT_CONNECTION_MODE,
} from "@/agents/chatops/constants";
import { agentFooter, EventDedupMap } from "@/agents/chatops/utils";
import { isRateLimited } from "@/agents/utils";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import {
  AgentModel,
  ChatOpsChannelBindingModel,
  ChatOpsConfigModel,
  OrganizationModel,
  UserModel,
} from "@/models";
import { ApiError, constructResponseSchema } from "@/types";
import {
  type ChatOpsProvider,
  type ChatOpsProviderType,
  ChatOpsProviderTypeSchema,
  type IncomingChatMessage,
} from "@/types/chatops";
import {
  ChatOpsChannelBindingResponseSchema,
  UpdateChatOpsChannelBindingSchema,
} from "@/types/chatops-channel-binding";

/**
 * Fastify preParsing hook that captures the raw request body before content-type
 * parsers (JSON parser, @fastify/formbody) consume the stream.
 * Required for Slack HMAC signature verification which signs the exact raw bytes.
 * The raw body is stored on `request.slackRawBody`.
 */
const captureSlackRawBody = async (
  request: { slackRawBody?: string },
  _reply: unknown,
  payload: AsyncIterable<Buffer | string>,
) => {
  const chunks: Buffer[] = [];
  for await (const chunk of payload) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  request.slackRawBody = raw;
  const { Readable } = await import("node:stream");
  return Readable.from(Buffer.from(raw));
};

/**
 * Fast-path dedup for webhook Slack events. Socket mode has its own instance
 * inside SlackProvider. See EventDedupMap for details.
 */
const slackWebhookDedup = new EventDedupMap();

const chatopsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * MS Teams webhook endpoint
   *
   * Receives Bot Framework activities from Microsoft Teams.
   * JWT validation is handled by the Bot Framework adapter.
   */
  fastify.post(
    "/api/webhooks/chatops/ms-teams",
    {
      config: {
        // Increase body limit for Bot Framework payloads
        rawBody: true,
      },
      schema: {
        description: "MS Teams Bot Framework webhook endpoint",
        tags: ["ChatOps Webhooks"],
        body: z.unknown(),
        response: {
          200: z.union([
            z.object({ status: z.string() }),
            z.object({ success: z.boolean() }),
          ]),
          400: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
          429: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
          500: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const provider = chatOpsManager.getMSTeamsProvider();

      if (!provider) {
        logger.warn(
          "[ChatOps] MS Teams webhook called but provider not configured",
        );
        throw new ApiError(400, "MS Teams chatops provider not configured");
      }

      // Rate limiting
      const clientIp = request.ip || "unknown";
      const rateLimitKey =
        `${CacheKey.WebhookRateLimit}-chatops-${clientIp}` as AllowedCacheKey;
      const rateLimitConfig = {
        windowMs: CHATOPS_RATE_LIMIT.WINDOW_MS,
        maxRequests: CHATOPS_RATE_LIMIT.MAX_REQUESTS,
      };
      if (await isRateLimited(rateLimitKey, rateLimitConfig)) {
        logger.warn(
          { ip: clientIp },
          "[ChatOps] Rate limit exceeded for MS Teams webhook",
        );
        throw new ApiError(429, "Too many requests");
      }

      // Extract headers
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = value;
      }

      try {
        // Process the activity through the Bot Framework adapter
        // This handles JWT validation automatically
        await provider.processActivity(
          { body: request.body, headers },
          {
            status: (code: number) => ({
              send: (data?: unknown) => {
                // Bot Framework sends various response formats - use type assertion for passthrough
                reply
                  .status(code as 200 | 400 | 429 | 500)
                  .send(data ? (data as never) : { status: "ok" });
              },
            }),
            send: (data?: unknown) => {
              // Bot Framework sends various response formats - use type assertion for passthrough
              reply.send(data ? (data as never) : { status: "ok" });
            },
          },
          async (context: TurnContext) => {
            // Check if this is a card submission (agent selection) FIRST
            // Card submissions have activity.value but no text, so we must check before parseWebhookNotification
            const activityValue = context.activity.value as
              | { action?: string; channelId?: string; workspaceId?: string }
              | undefined;
            if (activityValue?.action === "selectAgent") {
              // For card submissions, we need to construct a minimal message from the activity
              const cardMessage: IncomingChatMessage = {
                messageId: context.activity.id || `teams-${Date.now()}`,
                channelId:
                  activityValue.channelId ||
                  context.activity.channelData?.channel?.id ||
                  context.activity.conversation?.id ||
                  "",
                workspaceId:
                  activityValue.workspaceId ||
                  context.activity.channelData?.team?.id ||
                  null,
                threadId: context.activity.conversation?.id,
                senderId:
                  context.activity.from?.aadObjectId ||
                  context.activity.from?.id ||
                  "unknown",
                senderName: context.activity.from?.name || "Unknown User",
                text: "",
                rawText: "",
                timestamp: context.activity.timestamp
                  ? new Date(context.activity.timestamp)
                  : new Date(),
                isThreadReply: false,
                metadata: {},
              };
              // Resolve sender email and verify they are a registered Archestra user
              if (
                !(await resolveAndVerifySender(context, provider, cardMessage))
              ) {
                return;
              }

              await handleAgentSelection(context, cardMessage);
              return;
            }

            // Handle bot installation/update — discover all team channels
            if (
              context.activity.type === ActivityTypes.ConversationUpdate ||
              context.activity.type === ActivityTypes.InstallationUpdate
            ) {
              const teamData = context.activity.channelData?.team as
                | { id?: string; aadGroupId?: string }
                | undefined;
              if (teamData?.id) {
                let aadGroupId = teamData.aadGroupId;
                if (!aadGroupId) {
                  try {
                    const details = await TeamsInfo.getTeamDetails(context);
                    aadGroupId = details?.aadGroupId ?? undefined;
                  } catch {
                    // Non-fatal
                  }
                }
                const workspaceId = aadGroupId || teamData.id;
                const allWorkspaceIds = collectWorkspaceIds({
                  id: teamData.id,
                  aadGroupId,
                });
                // Await so discovery completes before the webhook returns,
                // but catch errors to avoid failing the webhook response.
                await chatOpsManager
                  .discoverChannels({
                    provider,
                    context,
                    workspaceId,
                    allWorkspaceIds,
                  })
                  .catch((error) => {
                    logger.error(
                      {
                        error:
                          error instanceof Error
                            ? error.message
                            : String(error),
                      },
                      "[ChatOps] Error discovering channels",
                    );
                  });
              }
              return;
            }

            // Parse the activity into our message format
            const message = await provider.parseWebhookNotification(
              context.activity,
              headers,
            );

            if (!message) {
              // Not a processable message (e.g., system event)
              return;
            }

            // Attach TurnContext so the provider can send typing indicators
            // using the live conversation turn (works in channels, group chats, and DMs).
            // Safe: setTypingStatus is called inside executeAndReply which runs
            // within this processActivity callback, so the TurnContext is still valid.
            message.metadata = {
              ...message.metadata,
              turnContext: context,
            };

            // Resolve workspaceId to proper UUID (aadGroupId) for team channels.
            // Bot Framework may provide team.id (thread format) instead of aadGroupId.
            // TeamsInfo.getTeamDetails() uses RSC permissions — no Azure AD app permissions needed.
            if (message.workspaceId && !isValidUUID(message.workspaceId)) {
              try {
                const teamDetails = await TeamsInfo.getTeamDetails(context);
                if (teamDetails?.aadGroupId) {
                  message.workspaceId = teamDetails.aadGroupId;
                }
              } catch {
                // Non-fatal — group chats don't have team details
              }
            }

            // Resolve sender email and verify they are a registered Archestra user
            if (!(await resolveAndVerifySender(context, provider, message))) {
              return;
            }

            // Check for commands
            const trimmedText = message.text.trim().toLowerCase();

            if (trimmedText === CHATOPS_COMMANDS.HELP) {
              await context.sendActivity({
                attachments: [
                  {
                    contentType: "application/vnd.microsoft.card.adaptive",
                    content: {
                      type: "AdaptiveCard",
                      $schema:
                        "http://adaptivecards.io/schemas/adaptive-card.json",
                      version: "1.4",
                      body: [
                        {
                          type: "TextBlock",
                          text: "**Available commands:**",
                          wrap: true,
                        },
                        {
                          type: "FactSet",
                          spacing: "Small",
                          facts: [
                            {
                              title: "/select-agent",
                              value: "Change the default agent",
                            },
                            {
                              title: "/status",
                              value: "Show current agent binding",
                            },
                            { title: "/help", value: "Show this help message" },
                          ],
                        },
                        {
                          type: "TextBlock",
                          text: "Or just send a message to interact with the bound agent.",
                          wrap: true,
                          spacing: "Medium",
                        },
                      ],
                    },
                  },
                ],
              });
              return;
            }

            if (trimmedText === CHATOPS_COMMANDS.STATUS) {
              const binding = await ChatOpsChannelBindingModel.findByChannel({
                provider: "ms-teams",
                channelId: message.channelId,
                workspaceId: message.workspaceId,
              });

              if (binding?.agentId) {
                const agent = await AgentModel.findById(binding.agentId);
                await context.sendActivity({
                  attachments: [
                    {
                      contentType: "application/vnd.microsoft.card.adaptive",
                      content: {
                        type: "AdaptiveCard",
                        $schema:
                          "http://adaptivecards.io/schemas/adaptive-card.json",
                        version: "1.4",
                        body: [
                          {
                            type: "TextBlock",
                            text: `This channel is bound to agent: **${agent?.name || binding.agentId}** which means it will handle all requests in the channel by default.`,
                            wrap: true,
                          },
                          {
                            type: "TextBlock",
                            text: `**Tip:** You can use other agents with the syntax **AgentName >** (e.g., @Archestra Sales > what's the status?).`,
                            wrap: true,
                          },
                          {
                            type: "TextBlock",
                            text: "Use **/select-agent** to change the default agent handling requests in the channel.",
                            wrap: true,
                            spacing: "Medium",
                          },
                        ],
                      },
                    },
                  ],
                });
              } else {
                await context.sendActivity({
                  attachments: [
                    {
                      contentType: "application/vnd.microsoft.card.adaptive",
                      content: {
                        type: "AdaptiveCard",
                        $schema:
                          "http://adaptivecards.io/schemas/adaptive-card.json",
                        version: "1.4",
                        body: [
                          {
                            type: "TextBlock",
                            text: "No agent is bound to this channel yet.",
                            wrap: true,
                          },
                          {
                            type: "TextBlock",
                            text: "Send any message to set up an agent binding.",
                            wrap: true,
                            spacing: "Medium",
                          },
                        ],
                      },
                    },
                  ],
                });
              }
              return;
            }

            if (trimmedText === CHATOPS_COMMANDS.SELECT_AGENT) {
              // Send agent selection card
              await sendAgentSelectionCard({
                provider,
                message,
                isWelcome: false,
                providerContext: context,
              });
              return;
            }

            // Check for existing binding
            const binding = await ChatOpsChannelBindingModel.findByChannel({
              provider: "ms-teams",
              channelId: message.channelId,
              workspaceId: message.workspaceId,
            });

            if (!binding || !binding.agentId) {
              // Create binding early (without agent) so the DM/channel appears in the UI
              if (!binding) {
                const isTeamsDm =
                  context.activity.conversation?.conversationType ===
                  "personal";
                const resolvedNames = await resolveTeamsNames(
                  context,
                  message.channelId,
                ).catch((error) => {
                  logger.warn(
                    { error, channelId: message.channelId },
                    "[ChatOps] Failed to resolve Teams names for early binding",
                  );
                  return {} as {
                    channelName?: string;
                    workspaceName?: string;
                  };
                });
                const organizationId = await getDefaultOrganizationId();
                await ChatOpsChannelBindingModel.upsertByChannel({
                  organizationId,
                  provider: "ms-teams",
                  channelId: message.channelId,
                  workspaceId: message.workspaceId,
                  workspaceName: resolvedNames.workspaceName,
                  channelName: isTeamsDm
                    ? `Direct Message - ${message.senderEmail}`
                    : resolvedNames.channelName,
                  isDm: isTeamsDm,
                  dmOwnerEmail: isTeamsDm ? message.senderEmail : undefined,
                });
              }

              // Discover channels + show agent selection
              await awaitDiscovery(provider, context);
              await sendAgentSelectionCard({
                provider,
                message,
                isWelcome: true,
                providerContext: context,
              });
              return;
            }

            // Refresh names + discover channels in parallel (must await — TurnContext proxy is revoked after callback returns)
            await Promise.all([
              refreshBindingNames(context, binding, message).catch(() => {}),
              awaitDiscovery(provider, context),
            ]);

            // Process message through bound agent
            await chatOpsManager.processMessage({
              message,
              provider,
              sendReply: true,
            });
          },
        );

        // If processActivity didn't send a response, send default
        if (!reply.sent) {
          return reply.send({ success: true });
        }
      } catch (error) {
        logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          "[ChatOps] Error processing MS Teams webhook",
        );
        throw new ApiError(500, "Internal server error");
      }
    },
  );

  /**
   * Slack webhook endpoint
   *
   * Receives events from Slack Events API.
   * Signature validation via HMAC SHA256 signing secret.
   */
  fastify.post(
    "/api/webhooks/chatops/slack",
    {
      // biome-ignore lint/suspicious/noExplicitAny: Fastify hook types don't align with our shared helper signature
      preParsing: [captureSlackRawBody as any],
      schema: {
        description: "Slack Events API webhook endpoint",
        tags: ["ChatOps Webhooks"],
        body: z.unknown(),
        response: {
          200: z.union([
            z.object({ challenge: z.string() }),
            z.object({ ok: z.boolean() }),
          ]),
          400: z.object({
            error: z.object({
              message: z.string(),
              type: z.string(),
            }),
          }),
          429: z.object({
            error: z.object({
              message: z.string(),
              type: z.string(),
            }),
          }),
          500: z.object({
            error: z.object({
              message: z.string(),
              type: z.string(),
            }),
          }),
        },
      },
    },
    async (request, reply) => {
      const provider = chatOpsManager.getSlackProvider();

      if (!provider) {
        logger.warn(
          "[ChatOps] Slack webhook called but provider not configured",
        );
        throw new ApiError(400, "Slack chatops provider not configured");
      }

      // Rate limiting
      const clientIp = request.ip || "unknown";
      const rateLimitKey =
        `${CacheKey.WebhookRateLimit}-chatops-slack-${clientIp}` as AllowedCacheKey;
      const rateLimitConfig = {
        windowMs: CHATOPS_RATE_LIMIT.WINDOW_MS,
        maxRequests: CHATOPS_RATE_LIMIT.MAX_REQUESTS,
      };
      if (await isRateLimited(rateLimitKey, rateLimitConfig)) {
        logger.warn(
          { ip: clientIp },
          "[ChatOps] Rate limit exceeded for Slack webhook",
        );
        throw new ApiError(429, "Too many requests");
      }

      const headers: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = value;
      }

      const body = request.body;

      // Socket mode guard — webhooks are not used in socket mode
      if (provider.isSocketMode()) {
        throw new ApiError(
          400,
          "Slack is configured for Socket Mode. Webhooks are disabled.",
        );
      }

      // Validate request signature FIRST — even url_verification challenges are signed.
      const rawBody = (request as unknown as { slackRawBody?: string })
        .slackRawBody;
      if (!rawBody) {
        throw new ApiError(400, "Could not read request body for verification");
      }
      const isValid = await provider.validateWebhookRequest(rawBody, headers);
      if (!isValid) {
        logger.warn("[ChatOps] Invalid Slack webhook signature");
        throw new ApiError(400, "Invalid request signature");
      }

      // Handle URL verification challenge (after signature is verified)
      const challengeResponse = provider.handleValidationChallenge(body) as {
        challenge: string;
      } | null;
      if (challengeResponse) {
        return reply.send(challengeResponse);
      }

      try {
        const slackBody = body as {
          type?: string;
          event?: { type?: string; ts?: string };
        };

        if (slackBody.type === "event_callback") {
          // Quick in-memory dedup for Slack's duplicate message+app_mention events
          const eventTs = slackBody.event?.ts;
          if (eventTs && slackWebhookDedup.mark(eventTs)) {
            return reply.send({ ok: true });
          }

          // Delegate to shared handler (async — return 200 immediately for Slack's 3s timeout)
          chatOpsManager
            .handleIncomingMessage(provider, body)
            .catch((error) => {
              logger.error(
                {
                  error: error instanceof Error ? error.message : String(error),
                },
                "[ChatOps] Error processing Slack message (async)",
              );
            });
        }

        return reply.send({ ok: true });
      } catch (error) {
        logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          "[ChatOps] Error processing Slack webhook",
        );
        throw new ApiError(500, "Internal server error");
      }
    },
  );

  /**
   * Slack interactive endpoint
   *
   * Receives block_actions payloads from Slack when users click buttons
   * (e.g., agent selection buttons).
   */
  fastify.post(
    "/api/webhooks/chatops/slack/interactive",
    {
      // biome-ignore lint/suspicious/noExplicitAny: Fastify hook types don't align with our shared helper signature
      preParsing: [captureSlackRawBody as any],
      schema: {
        description: "Slack interactive components endpoint",
        tags: ["ChatOps Webhooks"],
        body: z.unknown(),
        response: {
          200: z.object({ ok: z.boolean() }),
          400: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
          429: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const provider = chatOpsManager.getSlackProvider();
      if (!provider) {
        throw new ApiError(400, "Slack chatops provider not configured");
      }

      // Rate limiting
      const clientIp = request.ip || "unknown";
      const rateLimitKey =
        `${CacheKey.WebhookRateLimit}-chatops-slack-interactive-${clientIp}` as AllowedCacheKey;
      const rateLimitConfig = {
        windowMs: CHATOPS_RATE_LIMIT.WINDOW_MS,
        maxRequests: CHATOPS_RATE_LIMIT.MAX_REQUESTS,
      };
      if (await isRateLimited(rateLimitKey, rateLimitConfig)) {
        logger.warn(
          { ip: clientIp },
          "[ChatOps] Rate limit exceeded for Slack interactive webhook",
        );
        throw new ApiError(429, "Too many requests");
      }

      // Socket mode guard
      if (provider.isSocketMode()) {
        throw new ApiError(
          400,
          "Slack is configured for Socket Mode. Webhooks are disabled.",
        );
      }

      // Validate request signature using the captured raw body
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = value;
      }
      const rawBody = (request as unknown as { slackRawBody?: string })
        .slackRawBody;
      if (!rawBody) {
        throw new ApiError(400, "Could not read request body for verification");
      }
      const isValid = await provider.validateWebhookRequest(rawBody, headers);
      if (!isValid) {
        logger.warn("[ChatOps] Invalid Slack interactive webhook signature");
        throw new ApiError(400, "Invalid request signature");
      }

      // Slack sends interactive payloads as form-encoded with a "payload" field
      const formBody = request.body as { payload?: string };
      const payloadStr = formBody.payload;
      if (!payloadStr) {
        throw new ApiError(400, "Missing payload");
      }

      let payload: unknown;
      try {
        payload = JSON.parse(payloadStr);
      } catch {
        throw new ApiError(400, "Invalid payload JSON");
      }

      await chatOpsManager.handleInteractiveSelection(provider, payload);
      return reply.send({ ok: true });
    },
  );

  /**
   * Slack slash command endpoint
   *
   * Receives native slash command payloads from Slack.
   * Slack sends form-encoded body with: command, text, user_id, channel_id,
   * team_id, response_url, trigger_id.
   * All three commands share this single endpoint — `command` field distinguishes them.
   */
  fastify.post(
    "/api/webhooks/chatops/slack/slash-command",
    {
      // biome-ignore lint/suspicious/noExplicitAny: Fastify hook types don't align with our shared helper signature
      preParsing: [captureSlackRawBody as any],
      schema: {
        description: "Slack slash commands endpoint",
        tags: ["ChatOps Webhooks"],
        body: z.unknown(),
        response: {
          200: z.unknown(),
          400: z.object({
            error: z.object({
              message: z.string(),
              type: z.string(),
            }),
          }),
          429: z.object({
            error: z.object({
              message: z.string(),
              type: z.string(),
            }),
          }),
        },
      },
    },
    async (request, reply) => {
      const provider = chatOpsManager.getSlackProvider();
      if (!provider) {
        throw new ApiError(400, "Slack chatops provider not configured");
      }

      // Rate limiting
      const clientIp = request.ip || "unknown";
      const rateLimitKey =
        `${CacheKey.WebhookRateLimit}-chatops-slack-slash-${clientIp}` as AllowedCacheKey;
      const rateLimitConfig = {
        windowMs: CHATOPS_RATE_LIMIT.WINDOW_MS,
        maxRequests: CHATOPS_RATE_LIMIT.MAX_REQUESTS,
      };
      if (await isRateLimited(rateLimitKey, rateLimitConfig)) {
        throw new ApiError(429, "Too many requests");
      }

      // Socket mode guard
      if (provider.isSocketMode()) {
        throw new ApiError(
          400,
          "Slack is configured for Socket Mode. Webhooks are disabled.",
        );
      }

      // Validate request signature using the raw form-encoded body
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = value;
      }
      const rawBody = (request as unknown as { slackRawBody?: string })
        .slackRawBody;
      if (!rawBody) {
        throw new ApiError(400, "Could not read request body for verification");
      }
      const isValid = await provider.validateWebhookRequest(rawBody, headers);
      if (!isValid) {
        logger.warn("[ChatOps] Invalid Slack slash command signature");
        throw new ApiError(400, "Invalid request signature");
      }

      const body = request.body as {
        command?: string;
        text?: string;
        user_id?: string;
        user_name?: string;
        channel_id?: string;
        channel_name?: string;
        team_id?: string;
        response_url?: string;
        trigger_id?: string;
      };

      const response = await provider.handleSlashCommand(body);

      if (response) {
        return reply.send(response);
      }
      return reply.send({ response_type: "ephemeral", text: "" });
    },
  );

  /**
   * Get chatops status (provider configuration status)
   */
  fastify.get(
    "/api/chatops/status",
    {
      schema: {
        operationId: RouteId.GetChatOpsStatus,
        description: "Get chatops provider configuration status",
        tags: ["ChatOps"],
        response: constructResponseSchema(
          z.object({
            providers: z.array(
              z.object({
                id: z.string(),
                displayName: z.string(),
                configured: z.boolean(),
                credentials: z.record(z.string(), z.string()).optional(),
                dmInfo: z
                  .object({
                    botUserId: z.string().optional(),
                    teamId: z.string().optional(),
                    appId: z.string().optional(),
                  })
                  .optional(),
              }),
            ),
          }),
        ),
      },
    },
    async (_, reply) => {
      // Iterate through all provider types - automatically includes new providers
      // TypeScript exhaustiveness in getProviderInfo() ensures new providers are handled
      const providers = await Promise.all(
        ChatOpsProviderTypeSchema.options.map(getProviderInfo),
      );

      return reply.send({ providers });
    },
  );

  /**
   * List all channel bindings for the organization
   */
  fastify.get(
    "/api/chatops/bindings",
    {
      schema: {
        operationId: RouteId.ListChatOpsBindings,
        description: "List all chatops channel bindings",
        tags: ["ChatOps"],
        response: constructResponseSchema(
          z.array(ChatOpsChannelBindingResponseSchema),
        ),
      },
    },
    async (request, reply) => {
      const bindings = await ChatOpsChannelBindingModel.findByOrganization(
        request.organizationId,
      );

      // Filter out DM bindings that belong to other users
      const userEmail = request.user.email;
      const visibleBindings = bindings.filter((b) => {
        if (!b.isDm) return true;
        return b.dmOwnerEmail === userEmail;
      });

      return reply.send(
        visibleBindings.map((b) => ({
          ...b,
          createdAt: b.createdAt.toISOString(),
          updatedAt: b.updatedAt.toISOString(),
        })),
      );
    },
  );

  /**
   * Delete a channel binding
   */
  fastify.delete(
    "/api/chatops/bindings/:id",
    {
      schema: {
        operationId: RouteId.DeleteChatOpsBinding,
        description: "Delete a chatops channel binding",
        tags: ["ChatOps"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const deleted =
        await ChatOpsChannelBindingModel.deleteByIdAndOrganization(
          id,
          request.organizationId,
        );

      if (!deleted) {
        throw new ApiError(404, "Binding not found");
      }

      return reply.send({ success: true });
    },
  );

  /**
   * Update a channel binding's agent assignment
   */
  fastify.patch(
    "/api/chatops/bindings/:id",
    {
      schema: {
        operationId: RouteId.UpdateChatOpsBinding,
        description: "Update a chatops channel binding",
        tags: ["ChatOps"],
        params: z.object({
          id: z.string().uuid(),
        }),
        body: UpdateChatOpsChannelBindingSchema,
        response: constructResponseSchema(ChatOpsChannelBindingResponseSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await ChatOpsChannelBindingModel.findByIdAndOrganization(
        id,
        request.organizationId,
      );

      if (!existing) {
        throw new ApiError(404, "Binding not found");
      }

      const updated = await ChatOpsChannelBindingModel.update(id, request.body);

      if (!updated) {
        throw new ApiError(500, "Failed to update binding");
      }

      return reply.send({
        ...updated,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      });
    },
  );

  /**
   * Update MS Teams chatops config.
   * Persists to DB and reinitializes the chatops manager (which reloads from DB).
   */
  fastify.put(
    "/api/chatops/config/ms-teams",
    {
      schema: {
        operationId: RouteId.UpdateChatOpsConfigInQuickstart,
        description: "Update MS Teams chatops configuration",
        tags: ["ChatOps"],
        body: z.object({
          enabled: z.boolean().optional(),
          appId: z.string().min(1).max(256).optional(),
          appSecret: z.string().min(1).max(512).optional(),
          tenantId: z.string().min(1).max(256).optional(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      const { enabled, appId, appSecret, tenantId } = request.body;

      // Merge new values with existing DB config (or defaults for first setup)
      const existing = await ChatOpsConfigModel.getMsTeamsConfig();
      const merged = {
        enabled: enabled ?? existing?.enabled ?? false,
        appId: appId ?? existing?.appId ?? "",
        appSecret: appSecret ?? existing?.appSecret ?? "",
        tenantId: tenantId ?? existing?.tenantId ?? "",
        graphTenantId: tenantId ?? existing?.graphTenantId ?? "",
        graphClientId: appId ?? existing?.graphClientId ?? "",
        graphClientSecret: appSecret ?? existing?.graphClientSecret ?? "",
      };

      await ChatOpsConfigModel.saveMsTeamsConfig(merged);
      await chatOpsManager.reinitialize();

      return reply.send({ success: true });
    },
  );
  /**
   * Update Slack chatops config.
   * Persists to DB and reinitializes the chatops manager (which reloads from DB).
   */
  fastify.put(
    "/api/chatops/config/slack",
    {
      schema: {
        operationId: RouteId.UpdateSlackChatOpsConfig,
        description: "Update Slack chatops configuration",
        tags: ["ChatOps"],
        body: z.object({
          enabled: z.boolean().optional(),
          botToken: z.string().max(512).optional(),
          signingSecret: z.string().max(256).optional(),
          appId: z.string().max(256).optional(),
          connectionMode: z.enum(["webhook", "socket"]).optional(),
          appLevelToken: z.string().max(512).optional(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      const {
        enabled,
        botToken,
        signingSecret,
        appId,
        connectionMode,
        appLevelToken,
      } = request.body;

      // Merge new values with existing DB config (or defaults for first setup)
      const existing = await ChatOpsConfigModel.getSlackConfig();
      const merged = {
        enabled: enabled ?? existing?.enabled ?? false,
        botToken: botToken ?? existing?.botToken ?? "",
        signingSecret: signingSecret ?? existing?.signingSecret ?? "",
        appId: appId ?? existing?.appId ?? "",
        connectionMode:
          connectionMode ??
          existing?.connectionMode ??
          SLACK_DEFAULT_CONNECTION_MODE,
        appLevelToken: appLevelToken ?? existing?.appLevelToken ?? "",
      };

      await ChatOpsConfigModel.saveSlackConfig(merged);
      await chatOpsManager.reinitialize();

      return reply.send({ success: true });
    },
  );

  /**
   * Refresh channel discovery for a provider.
   * Clears the TTL cache, then triggers immediate discovery if the provider
   * supports it (e.g., Slack). Otherwise channels are re-discovered on the
   * next bot interaction (e.g., MS Teams).
   */
  fastify.post(
    "/api/chatops/channel-discovery/refresh",
    {
      schema: {
        operationId: RouteId.RefreshChatOpsChannelDiscovery,
        description: "Refresh channel discovery cache for a chatops provider",
        tags: ["ChatOps"],
        body: z.object({
          provider: ChatOpsProviderTypeSchema,
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      const { provider: providerType } = request.body;
      const prefix =
        `${CacheKey.ChannelDiscovery}-${providerType}` as AllowedCacheKey;
      await cacheManager.deleteByPrefix(prefix);

      // If the provider can discover channels eagerly, do it now
      const provider = chatOpsManager.getChatOpsProvider(providerType);
      const workspaceId = provider?.getWorkspaceId();
      if (provider && workspaceId) {
        await chatOpsManager.discoverChannels({
          provider,
          context: null,
          workspaceId,
        });
      }

      // Backfill workspace name on bindings that are missing it (e.g. DMs)
      await ChatOpsChannelBindingModel.backfillWorkspaceName({
        provider: providerType,
        workspaceName: provider?.getWorkspaceName() ?? undefined,
      });

      return reply.send({ success: true });
    },
  );
};

export default chatopsRoutes;

// =============================================================================
// Internal Helpers (not exported)
// =============================================================================

/**
 * Get the default organization ID (single-tenant mode)
 */
async function getDefaultOrganizationId(): Promise<string> {
  const org = await OrganizationModel.getFirst();
  if (!org) {
    throw new Error("No organizations found");
  }
  return org.id;
}

/**
 * Get provider info for status endpoint.
 * Reads credentials from DB (the single source of truth).
 * Uses exhaustive switch to force updates when new providers are added.
 */
async function getProviderInfo(providerType: ChatOpsProviderType): Promise<{
  id: ChatOpsProviderType;
  displayName: string;
  configured: boolean;
  credentials?: Record<string, string>;
  dmInfo?: { botUserId?: string; teamId?: string; appId?: string };
}> {
  switch (providerType) {
    case "ms-teams": {
      const provider = chatOpsManager.getMSTeamsProvider();
      const dbConfig = await ChatOpsConfigModel.getMsTeamsConfig();
      return {
        id: "ms-teams",
        displayName: "Microsoft Teams",
        configured: provider?.isConfigured() ?? false,
        credentials: {
          appId: maskValue(dbConfig?.appId ?? ""),
          appSecret: dbConfig?.appSecret ? "••••••••" : "",
          tenantId: maskValue(dbConfig?.tenantId ?? ""),
        },
        dmInfo: dbConfig?.appId ? { appId: dbConfig.appId } : undefined,
      };
    }
    case "slack": {
      const provider = chatOpsManager.getSlackProvider();
      const dbConfig = await ChatOpsConfigModel.getSlackConfig();
      const isSocket = dbConfig?.connectionMode === "socket";
      const credentials: Record<string, string> = {
        botToken: maskValue(dbConfig?.botToken ?? ""),
        appId: maskValue(dbConfig?.appId ?? ""),
        connectionMode:
          dbConfig?.connectionMode ?? SLACK_DEFAULT_CONNECTION_MODE,
      };
      if (isSocket) {
        credentials.appLevelToken = maskValue(dbConfig?.appLevelToken ?? "");
      } else {
        credentials.signingSecret = dbConfig?.signingSecret ? "••••••••" : "";
      }
      return {
        id: "slack",
        displayName: "Slack",
        configured: provider?.isConfigured() ?? false,
        credentials,
        dmInfo:
          provider?.getBotUserId() || provider?.getWorkspaceId()
            ? {
                botUserId: provider.getBotUserId() ?? undefined,
                teamId: provider.getWorkspaceId() ?? undefined,
              }
            : undefined,
      };
    }
  }
}

function maskValue(value: string): string {
  if (!value) return "";
  if (value.length <= 3) return "•".repeat(value.length);
  return value.slice(0, 3) + "•".repeat(Math.min(value.length - 3, 8));
}

/**
 * Shared helper: get accessible agents and send agent selection card via the provider.
 * Both MS Teams and Slack handlers call this instead of provider-specific functions.
 */
async function sendAgentSelectionCard(params: {
  provider: ChatOpsProvider;
  message: IncomingChatMessage;
  isWelcome: boolean;
  providerContext?: unknown;
}): Promise<void> {
  const agents = await chatOpsManager.getAccessibleChatopsAgents({
    senderEmail: params.message.senderEmail,
  });

  if (agents.length === 0) {
    await params.provider.sendReply({
      originalMessage: params.message,
      text: `No agents are available for you in ${params.provider.displayName}.\nContact your administrator to get access to an agent with ${params.provider.displayName} enabled.`,
    });
    return;
  }

  await params.provider.sendAgentSelectionCard({
    message: params.message,
    agents,
    isWelcome: params.isWelcome,
    providerContext: params.providerContext,
  });
}

/**
 * Handle agent selection from Adaptive Card submission
 */
async function handleAgentSelection(
  context: TurnContext,
  message: IncomingChatMessage,
): Promise<void> {
  const value = context.activity.value as
    | {
        agentId?: string;
        channelId?: string;
        workspaceId?: string;
        originalMessageText?: string;
      }
    | undefined;
  const { agentId, channelId, workspaceId, originalMessageText } = value || {};

  if (!agentId) {
    await context.sendActivity("Please select an agent from the dropdown.");
    return;
  }

  // Verify the agent exists
  const agent = await AgentModel.findById(agentId);
  if (!agent) {
    await context.sendActivity(
      "The selected agent no longer exists. Please try again.",
    );
    return;
  }

  // Get the default organization
  const organizationId = await getDefaultOrganizationId();

  logger.debug(
    {
      organizationId,
      channelId: channelId || message.channelId,
      workspaceId: workspaceId || message.workspaceId,
      workspaceIdType: typeof (workspaceId || message.workspaceId),
      agentId,
      agentName: agent.name,
      originalMessageText,
    },
    "[ChatOps] handleAgentSelection: about to upsert binding",
  );

  // Resolve human-readable channel/workspace names (best-effort)
  const resolvedNames = await resolveTeamsNames(
    context,
    channelId || message.channelId,
  );

  // DMs have conversationType "personal" — use a readable name for DM bindings
  const isTeamsDm =
    context.activity.conversation?.conversationType === "personal";
  const channelName = isTeamsDm
    ? `Direct Message - ${message.senderEmail}`
    : resolvedNames.channelName;

  // Create or update the binding
  const binding = await ChatOpsChannelBindingModel.upsertByChannel({
    organizationId,
    provider: "ms-teams",
    channelId: channelId || message.channelId,
    workspaceId: workspaceId || message.workspaceId,
    channelName,
    workspaceName: resolvedNames.workspaceName,
    isDm: isTeamsDm,
    dmOwnerEmail: isTeamsDm ? message.senderEmail : undefined,
    agentId,
  });

  // Clean up duplicate bindings for the same channel with different workspaceId formats
  await ChatOpsChannelBindingModel.deleteDuplicateBindings({
    provider: "ms-teams",
    channelId: channelId || message.channelId,
    canonicalBindingId: binding.id,
  });

  logger.debug("[ChatOps] handleAgentSelection: binding upserted");

  // If there was an original message (not a command), process it now
  if (originalMessageText && !isCommand(originalMessageText)) {
    logger.debug(
      { originalMessageText },
      "[ChatOps] handleAgentSelection: about to send 'processing' message",
    );
    await context.sendActivity(
      `Agent **${agent.name}** is now bound to this ${isTeamsDm ? "conversation" : "channel"}. Processing your message...`,
    );
    logger.debug(
      "[ChatOps] handleAgentSelection: 'processing' message sent, about to call processMessage",
    );

    // Get the provider and process the original message
    const provider = chatOpsManager.getMSTeamsProvider();
    if (provider) {
      // Construct a message object for processing
      const originalMessage: IncomingChatMessage = {
        messageId: `${message.messageId}-original`,
        channelId: channelId || message.channelId,
        workspaceId: workspaceId || message.workspaceId,
        threadId: message.threadId,
        senderId: message.senderId,
        senderName: message.senderName,
        senderEmail: message.senderEmail,
        text: originalMessageText,
        rawText: originalMessageText,
        timestamp: message.timestamp,
        isThreadReply: message.isThreadReply,
        metadata: {
          conversationReference: TurnContext.getConversationReference(
            context.activity,
          ),
        },
      };

      // Use sendReply: false and handle the response/error here using the turn context
      // This ensures replies appear in the correct thread
      const result = await chatOpsManager.processMessage({
        message: originalMessage,
        provider,
        sendReply: false,
      });

      if (result.success && result.agentResponse) {
        // Send agent response via turn context (ensures correct thread)
        await context.sendActivity(
          `${result.agentResponse}\n\n---\n_${agentFooter(agent.name)}_`,
        );
      } else if (!result.success && result.error) {
        // Send error message via turn context (ensures correct thread)
        const errorMessage = getSecurityErrorMessage(result.error);
        await context.sendActivity(`⚠️ **Access Denied**\n\n${errorMessage}`);
      }
    }
  } else {
    await context.sendActivity(
      `Agent **${agent.name}** is now bound to this ${isTeamsDm ? "conversation" : "channel"}.\n` +
        "Send a message (with @mention) to start interacting!",
    );
  }
}

/**
 * Check if the message text is a command (starts with /)
 */
function isCommand(text: string): boolean {
  return text.trim().startsWith("/");
}

/**
 * Resolve sender email (TeamsInfo → Graph API fallback) and verify they are a registered Archestra user.
 * Sets message.senderEmail and returns true if verified, false if rejected (with error sent to Teams).
 */
async function resolveAndVerifySender(
  context: TurnContext,
  provider: { getUserEmail(aadObjectId: string): Promise<string | null> },
  message: IncomingChatMessage,
): Promise<boolean> {
  // Try Bot Framework first (no Graph API permissions needed)
  try {
    const member = await TeamsInfo.getMember(context, context.activity.from.id);
    if (member?.email || member?.userPrincipalName) {
      message.senderEmail = member.email || member.userPrincipalName;
    }
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      "[ChatOps] TeamsInfo.getMember failed, will fall back to Graph API if configured",
    );
  }

  // Fall back to Graph API if TeamsInfo didn't resolve email
  if (!message.senderEmail) {
    const graphEmail = await provider.getUserEmail(message.senderId);
    if (graphEmail) {
      message.senderEmail = graphEmail;
    }
  }

  // Verify the sender is a registered Archestra user
  if (!message.senderEmail) {
    logger.warn(
      "[ChatOps] Could not resolve sender email for early auth check",
    );
    await context.sendActivity(
      "Could not verify your identity. Please ensure the bot is properly installed in your team or chat.",
    );
    return false;
  }

  const user = await UserModel.findByEmail(message.senderEmail.toLowerCase());
  if (!user) {
    logger.warn("[ChatOps] Sender is not a registered Archestra user");
    logger.debug(
      { senderEmail: message.senderEmail },
      "[ChatOps] Unregistered sender email",
    );
    await context.sendActivity(
      `You (${message.senderEmail}) are not a registered Archestra user. Contact your administrator for access.`,
    );
    return false;
  }

  return true;
}

/**
 * Resolve human-readable channel and workspace names via TeamsInfo.
 * Returns undefined for names that cannot be resolved — callers treat these as best-effort.
 */
async function resolveTeamsNames(
  context: TurnContext,
  targetChannelId: string,
): Promise<{ channelName?: string; workspaceName?: string }> {
  let channelName: string | undefined;
  let workspaceName: string | undefined;

  try {
    const teamDetails = await TeamsInfo.getTeamDetails(context);
    workspaceName = teamDetails?.name ?? undefined;
  } catch {
    /* non-fatal */
  }

  try {
    const channels = await TeamsInfo.getTeamChannels(context);
    const matched = channels?.find((c) => c.id === targetChannelId);
    channelName = matched?.name ?? undefined;
  } catch {
    /* non-fatal */
  }

  return { channelName, workspaceName };
}

/**
 * Refresh channel/workspace display names on a binding if they have changed.
 * Called fire-and-forget on every incoming message so names stay up-to-date.
 */
async function refreshBindingNames(
  context: TurnContext,
  binding: {
    id: string;
    channelId: string;
    channelName: string | null;
    workspaceName: string | null;
  },
  message: IncomingChatMessage,
): Promise<void> {
  try {
    const resolved = await resolveTeamsNames(context, message.channelId);

    const namesDiffer =
      (resolved.channelName !== undefined &&
        resolved.channelName !== binding.channelName) ||
      (resolved.workspaceName !== undefined &&
        resolved.workspaceName !== binding.workspaceName);

    if (namesDiffer) {
      await ChatOpsChannelBindingModel.updateNames(binding.id, {
        channelName: resolved.channelName,
        workspaceName: resolved.workspaceName,
      });
    }
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      "[ChatOps] Failed to refresh binding names",
    );
  }
}

/**
 * Await channel discovery via the ChatOpsManager.
 * Must be awaited (not fire-and-forget) because Bot Framework revokes the
 * TurnContext proxy once the processActivity callback returns.
 * The TTL cache makes this essentially free on cache hits.
 */
async function awaitDiscovery(
  provider: ChatOpsProvider,
  context: TurnContext,
): Promise<void> {
  const teamData = context.activity.channelData?.team as
    | { id?: string; aadGroupId?: string }
    | undefined;
  if (!teamData?.id) return;

  // Resolve aadGroupId (UUID) via TeamsInfo if not present in channelData.
  // This ensures stale cleanup covers bindings stored with either ID format.
  let aadGroupId = teamData.aadGroupId;
  if (!aadGroupId) {
    try {
      const details = await TeamsInfo.getTeamDetails(context);
      aadGroupId = details?.aadGroupId ?? undefined;
    } catch {
      // Non-fatal — group chats don't have team details
    }
  }

  const workspaceId = aadGroupId || teamData.id;
  const allWorkspaceIds = collectWorkspaceIds({
    id: teamData.id,
    aadGroupId,
  });
  await chatOpsManager
    .discoverChannels({ provider, context, workspaceId, allWorkspaceIds })
    .catch(() => {});
}

/**
 * Convert internal error codes to user-friendly messages
 */
function getSecurityErrorMessage(error: string): string {
  if (error.includes("Could not resolve user email")) {
    return "Could not verify your identity. Please ensure the bot is properly installed in your team or chat.";
  }
  if (error.includes("not a registered Archestra user")) {
    // Extract email from error message if present
    const emailMatch = error.match(/Unauthorized: (.+?) is not/);
    const email = emailMatch?.[1] || "Your email";
    return `${email} is not a registered Archestra user. Contact your administrator for access.`;
  }
  if (error.includes("does not have access to this agent")) {
    return "You don't have access to this agent. Contact your administrator for access.";
  }
  // Fallback for other errors
  return error;
}

/**
 * Collect all known workspace ID variants for a team.
 * Teams can be identified by either an aadGroupId (UUID) or a thread-format ID.
 * Bindings may have been created with either format, so we need both for stale cleanup.
 */
function collectWorkspaceIds(teamData: {
  id?: string;
  aadGroupId?: string;
}): string[] {
  const ids = new Set<string>();
  if (teamData.id) ids.add(teamData.id);
  if (teamData.aadGroupId) ids.add(teamData.aadGroupId);
  return [...ids];
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}
