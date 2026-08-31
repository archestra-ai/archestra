import { randomUUID } from "node:crypto";
import {
  AUTO_PROVISIONED_INVITATION_STATUS,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
  TimeInMs,
} from "@archestra/shared";
import { WebClient } from "@slack/web-api";
import { ActivityTypes, TeamsInfo, TurnContext } from "botbuilder";
import { MicrosoftAppCredentials } from "botframework-connector";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  autoProvisionUser,
  buildWelcomeMessage,
  resolveSignupWelcomeMode,
} from "@/agents/chatops/auto-provision";
import {
  applyChannelGate,
  findWorkspacesWithUnmentionedTraffic,
  invalidateChannelAnswerAll,
  isChannelAnswerAllEnabled,
  muteChannelThreadAndNotify,
  recordUnmentionedChannelTraffic,
} from "@/agents/chatops/channel-activation";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import {
  buildThreadMutedNotice,
  CHATOPS_COMMANDS,
  CHATOPS_RATE_LIMIT,
  SLACK_DEFAULT_CONNECTION_MODE,
  TELEGRAM_LINK_CODE_TTL_MS,
} from "@/agents/chatops/constants";
import {
  buildAgentFooter,
  EventDedupMap,
  errorMessage,
  stripDuplicateAgentFooter,
} from "@/agents/chatops/utils";
import { isRateLimited } from "@/agents/utils";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { hasPermission } from "@/auth";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import {
  AgentModel,
  ChatOpsChannelBindingModel,
  ChatOpsConfigModel,
  InvitationModel,
  OrganizationModel,
  UserModel,
} from "@/models";
import { ngrokTunnelManager } from "@/ngrok-tunnel-manager";
import { assertMessagingChannelAllowed } from "@/services/integration-overrides";
import {
  ApiError,
  type ChatOpsConnectionMode,
  ChatOpsConnectionModeSchema,
  type ChatOpsProvider,
  type ChatOpsProviderType,
  ChatOpsProviderTypeSchema,
  ChatOpsStatusResponseSchema,
  ChatOpsStatusSchema,
  constructResponseSchema,
  createSortingQuerySchema,
  type IncomingChatMessage,
} from "@/types";
import {
  ChatOpsChannelBindingResponseSchema,
  UpdateChatOpsChannelBindingSchema,
} from "@/types/chatops-channel-binding";
import { isUuid } from "@/utils/uuid";

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

const ChatOpsAssignmentPlanUpdateSchema =
  UpdateChatOpsChannelBindingSchema.pick({
    answerAllMessages: true,
    channelInstructions: true,
  }).extend({
    bindingId: z.string().uuid(),
    expectedAgentId: z.string().uuid().nullable(),
    nextAgentId: z.string().uuid().nullable(),
  });

const ChatOpsAssignmentPlanSchema = z
  .object({
    targetAgentId: z.string().uuid(),
    updates: z.array(ChatOpsAssignmentPlanUpdateSchema).max(500),
    directMessages: z
      .array(
        z.object({
          provider: ChatOpsProviderTypeSchema,
        }),
      )
      .max(100),
  })
  .superRefine(({ targetAgentId, updates, directMessages }, ctx) => {
    if (updates.length === 0 && directMessages.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Provide at least one binding update or direct message",
      });
    }

    const bindingIds = new Set(updates.map((update) => update.bindingId));
    if (bindingIds.size !== updates.length) {
      ctx.addIssue({
        code: "custom",
        path: ["updates"],
        message: "Each binding can only be updated once",
      });
    }

    updates.forEach((update, index) => {
      if (update.nextAgentId !== null && update.nextAgentId !== targetAgentId) {
        ctx.addIssue({
          code: "custom",
          path: ["updates", index, "nextAgentId"],
          message: "Each next agent must be the target agent or null",
        });
      }
    });

    const directMessageKeys = new Set(
      directMessages.map((directMessage) => directMessage.provider),
    );
    if (directMessageKeys.size !== directMessages.length) {
      ctx.addIssue({
        code: "custom",
        path: ["directMessages"],
        message: "Each direct message provider must be unique",
      });
    }
  });

/**
 * MS Teams incoming webhook, split out into its own plugin so the optional
 * public-endpoints listener (ARCHESTRA_PUBLIC_ENDPOINTS_PORT) can serve this
 * endpoint without the rest of the chatops routes (Slack webhooks, management
 * APIs). It is also registered by chatopsRoutes below, so the main API port
 * always serves it too.
 */
export const msTeamsWebhookRoutes: FastifyPluginAsyncZod = async (fastify) => {
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
                !(await resolveAndVerifySenderForMSTeams({
                  context,
                  provider,
                  message: cardMessage,
                  // A card submit is a direct interaction with the bot.
                  announce: true,
                }))
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

            // Mute reaction: a 🔇/🤫 reaction on one of the bot's OWN channel
            // replies mutes that thread. Pure side effect, handled before
            // message parsing since reactions aren't messages.
            const muteReaction = provider.parseMuteReaction(context.activity);
            if (muteReaction) {
              await muteTeamsThreadAndNotify(context, {
                provider: "ms-teams",
                channelId: muteReaction.channelId,
                threadId: muteReaction.threadId,
              });
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

            // Team-channel auto-reply gate: in channels the bot stays quiet
            // until @mentioned, then keeps replying to that thread without
            // further mentions, unless the channel opted into answering every
            // message. Group chats and DMs always reply (no gate). Runs before
            // sender resolution so we don't do Graph lookups for the many
            // un-mentioned channel messages the bot now receives.
            //
            // A mute command (e.g. "@bot mute") ends the sticky behavior early —
            // honored both when the bot is mentioned and when the thread is
            // already active (so muting needs no re-mention) — after which the
            // bot stays quiet until @mentioned again.
            let addressed = true;
            if (context.activity.conversation?.conversationType === "channel") {
              const botMentioned = provider.wasBotMentioned(context.activity);
              const gate = await applyChannelGate({
                provider: "ms-teams",
                channelId: message.channelId,
                threadId: message.threadId ?? message.channelId,
                botMentioned,
                text: message.text,
                // Teams stamps the bot's display name on every activity.
                botDisplayName: context.activity.recipient?.name,
                postMutedNotice: async () => {
                  await context.sendActivity(buildThreadMutedNotice());
                },
                resolveAnswerAllWorkspaceId: async () => {
                  const teamId = await resolveTeamsWorkspaceId(
                    context,
                    message,
                  );
                  // Teams only delivers an un-mentioned channel message once a
                  // team owner consented to the channel-message RSC permission,
                  // so arriving here without a mention proves that consent —
                  // which is what "answer all messages" silently depends on.
                  //
                  // Skipped unless the team id canonicalized: bindings store the
                  // aadGroupId, so a marker under the thread-format fallback
                  // would never be found again. And a failure here only costs a
                  // stale hint, so it must never disturb the gate.
                  if (!botMentioned && teamId && isUuid(teamId)) {
                    await recordUnmentionedChannelTraffic({
                      provider: "ms-teams",
                      workspaceId: teamId,
                    }).catch((error) => {
                      logger.warn(
                        { error: errorMessage(error), teamId },
                        "[ChatOps] Could not record un-mentioned channel traffic",
                      );
                    });
                  }
                  return teamId;
                },
              });
              if (!gate.proceed) return;
              addressed = gate.addressed;
            }

            // Attach TurnContext so the provider can send typing indicators
            // using the live conversation turn (works in channels, group chats, and DMs).
            // Safe: setTypingStatus is called inside executeAndReply which runs
            // within this processActivity callback, so the TurnContext is still valid.
            message.metadata = {
              ...message.metadata,
              turnContext: context,
            };

            // Bindings are stored under the team's aadGroupId, which Bot
            // Framework often withholds in favour of the thread-format team.id.
            // A no-op when the gate above already resolved it.
            await resolveTeamsWorkspaceId(context, message);

            // Resolve sender email and verify they are a registered Archestra user
            if (
              !(await resolveAndVerifySenderForMSTeams({
                context,
                provider,
                message,
                announce: addressed,
              }))
            ) {
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
                            {
                              title: "mute",
                              value:
                                "Stop auto-replies in this thread (@mention me to resume)",
                            },
                          ],
                        },
                        {
                          type: "TextBlock",
                          text: "Or just send a message to interact with the assigned agent.",
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
                            text: `This channel is assigned to agent: **${agent?.name || binding.agentId}** which means it will handle all requests in the channel by default.`,
                            wrap: true,
                          },
                          {
                            type: "TextBlock",
                            text: `**Tip:** You can use other agents with the syntax **AgentName >** (e.g., @${archestraMcpBranding.appName} Sales > what's the status?).`,
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
                            text: "No agent is assigned to this channel yet.",
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
              const isTeamsDm =
                context.activity.conversation?.conversationType === "personal";
              await sendAgentSelectionCard({
                provider,
                message,
                isWelcome: false,
                providerContext: context,
                isDm: isTeamsDm,
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
              const isTeamsDm =
                context.activity.conversation?.conversationType === "personal";

              // Create binding early (without agent) so the DM/channel appears in the UI
              if (!binding) {
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

              // If this is a DM and user has a pending auto-provisioned invitation,
              // send the signup (or SSO sign-in) link before the agent
              // selection card.
              const welcomeMode =
                isTeamsDm && message.senderEmail
                  ? await resolveSignupWelcomeMode()
                  : "none";
              if (message.senderEmail && welcomeMode !== "none") {
                const invitations = await InvitationModel.findByEmail(
                  message.senderEmail.toLowerCase(),
                );
                const autoProvInv = invitations.find((inv) =>
                  inv.status?.startsWith(AUTO_PROVISIONED_INVITATION_STATUS),
                );
                if (autoProvInv) {
                  const welcome = await buildWelcomeMessage({
                    mode: welcomeMode,
                    invitationId: autoProvInv.id,
                    email: message.senderEmail,
                    name: message.senderName,
                  });
                  await context
                    .sendActivity(
                      `${welcome.text}\n\n[${welcome.actionLabel}](${welcome.actionUrl})`,
                    )
                    .catch(() => {});
                }
              }

              // Discover channels + show agent selection. The card is a prompt to
              // pick an agent, so it only makes sense for someone who addressed
              // the bot — in an answer-all channel with no agent assigned it would
              // otherwise be posted publicly on every message.
              await awaitDiscovery(provider, context);
              if (addressed) {
                await sendAgentSelectionCard({
                  provider,
                  message,
                  isWelcome: true,
                  providerContext: context,
                  isDm: isTeamsDm,
                });
              }
              return;
            }

            // Refresh names + discover channels in parallel (must await — TurnContext proxy is revoked after callback returns)
            await Promise.all([
              refreshBindingNames(context, binding, message).catch(() => {}),
              awaitDiscovery(provider, context),
            ]);

            // Process message through assigned agent
            await chatOpsManager.processMessage({
              message,
              provider,
              sendReply: true,
              announceAccessErrors: addressed,
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
};

const chatopsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  await fastify.register(msTeamsWebhookRoutes);

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
          event?: { type?: string; ts?: string; event_ts?: string };
        };

        if (slackBody.type === "event_callback") {
          // Quick in-memory dedup for Slack's duplicate message+app_mention events.
          // Messages carry event.ts; reaction events carry event.event_ts.
          const eventTs = slackBody.event?.ts ?? slackBody.event?.event_ts;
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

      if (provider.handleInteractivePayload) {
        await provider.handleInteractivePayload(payload);
      } else {
        await chatOpsManager.handleInteractiveSelection(provider, payload);
      }
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
        response: constructResponseSchema(ChatOpsStatusResponseSchema),
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
   * List channel bindings for the organization with server-side pagination
   */
  fastify.get(
    "/api/chatops/bindings",
    {
      schema: {
        operationId: RouteId.ListChatOpsBindings,
        description: "List chatops channel bindings with pagination",
        tags: ["ChatOps"],
        querystring: z
          .object({
            provider: ChatOpsProviderTypeSchema.optional(),
            workspaceId: z.string().optional(),
            search: z.string().optional(),
            status: ChatOpsStatusSchema.optional(),
          })
          .merge(PaginationQuerySchema)
          .merge(
            createSortingQuerySchema(["channelName", "createdAt"] as const),
          ),
        response: constructResponseSchema(
          createPaginatedResponseSchema(
            ChatOpsChannelBindingResponseSchema,
          ).extend({
            counts: z.object({
              configured: z.number(),
              unassigned: z.number(),
            }),
            workspaces: z.array(z.object({ id: z.string(), name: z.string() })),
            hasDmBinding: z.boolean(),
            /**
             * Workspaces on this page known to deliver un-mentioned channel
             * messages. Absence means "nothing seen yet", never "consent
             * missing" — see recordUnmentionedChannelTraffic.
             */
            workspacesWithUnmentionedTraffic: z.array(z.string()),
          }),
        ),
      },
    },
    async (request, reply) => {
      const {
        limit,
        offset,
        sortBy,
        sortDirection,
        provider,
        workspaceId,
        search,
        status,
      } = request.query;

      const result = await ChatOpsChannelBindingModel.findAllPaginated({
        organizationId: request.organizationId,
        userEmail: request.user.email,
        pagination: { limit, offset },
        sorting: { sortBy, sortDirection },
        filters: { provider, workspaceId, search, status },
      });

      return reply.send({
        data: result.data.map((b) => ({
          ...b,
          createdAt: b.createdAt.toISOString(),
          updatedAt: b.updatedAt.toISOString(),
        })),
        pagination: result.pagination,
        counts: result.counts,
        workspaces: result.workspaces,
        hasDmBinding: result.hasDmBinding,
        workspacesWithUnmentionedTraffic: provider
          ? await findWorkspacesWithUnmentionedTraffic({
              provider,
              workspaceIds: [
                ...new Set(
                  result.data.flatMap((b) =>
                    b.workspaceId ? [b.workspaceId] : [],
                  ),
                ),
              ],
            })
          : [],
      });
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

      // Otherwise a deleted answer-all channel keeps replying to every message
      // until the cached flag lapses.
      await invalidateChannelAnswerAll({
        provider: deleted.provider,
        channelId: deleted.channelId,
        workspaceId: deleted.workspaceId,
      });

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

      // Validate personal agent assignment
      if (request.body.agentId) {
        await validateAgentChannelAssignment({
          agentId: request.body.agentId,
          isDm: existing.isDm,
          userId: request.user.id,
          userEmail: request.user.email,
          dmOwnerEmails: [existing.dmOwnerEmail],
          organizationId: request.organizationId,
        });
      }

      const updated =
        await ChatOpsChannelBindingModel.updateByIdAndOrganization({
          id,
          organizationId: request.organizationId,
          input: request.body,
        });

      if (!updated) {
        throw new ApiError(500, "Failed to update binding");
      }

      // Drop the cached "answer all messages" flag so the message gate picks up
      // the change without waiting for the short cache TTL to lapse.
      if (request.body.answerAllMessages !== undefined) {
        await invalidateChannelAnswerAll({
          provider: updated.provider,
          channelId: updated.channelId,
          workspaceId: updated.workspaceId,
        });
      }

      return reply.send({
        ...updated,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      });
    },
  );

  /**
   * Create a pending DM binding (before actual DM interaction).
   * Uses a placeholder channelId that gets fulfilled on first real DM.
   */
  fastify.post(
    "/api/chatops/bindings/dm",
    {
      schema: {
        operationId: RouteId.CreateChatOpsDmBinding,
        description:
          "Create a pending DM binding so an agent can be pre-assigned before the first DM interaction",
        tags: ["ChatOps"],
        body: z.object({
          provider: ChatOpsProviderTypeSchema,
          agentId: z.string().uuid().nullable(),
          requireNoExistingBinding: z.literal(true).optional(),
        }),
        response: constructResponseSchema(ChatOpsChannelBindingResponseSchema),
      },
    },
    async (request, reply) => {
      const { provider, agentId, requireNoExistingBinding } = request.body;
      await assertMessagingChannelAllowed({
        organizationId: request.organizationId,
        channel: provider,
      });
      const userEmail = request.user.email;

      // Validate personal agent assignment for DM
      if (agentId) {
        await validateAgentChannelAssignment({
          agentId,
          isDm: true,
          userId: request.user.id,
          userEmail,
          dmOwnerEmails: [userEmail],
          organizationId: request.organizationId,
        });
      }

      // Check if user already has a DM binding (real or pending) for this provider
      const existingDm =
        await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
          organizationId: request.organizationId,
          provider,
          dmOwnerEmail: userEmail,
        });

      if (existingDm) {
        if (requireNoExistingBinding) {
          throw new ApiError(
            409,
            "The direct message assignment already exists. Reload the channels and try again.",
          );
        }
        // Update the existing binding's agent
        const updated =
          await ChatOpsChannelBindingModel.updateByIdAndOrganization({
            id: existingDm.id,
            organizationId: request.organizationId,
            input: { agentId },
          });
        if (!updated) {
          throw new ApiError(500, "Failed to update DM binding");
        }
        return reply.send({
          ...updated,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        });
      }

      // Create a new pending DM binding with placeholder channelId
      const pendingChannelId = ChatOpsChannelBindingModel.pendingDmChannelId({
        organizationId: request.organizationId,
        dmOwnerEmail: userEmail,
      });
      const binding = await ChatOpsChannelBindingModel.createPendingDmIfAbsent({
        organizationId: request.organizationId,
        provider,
        channelId: pendingChannelId,
        workspaceId: "dm:pending",
        isDm: true,
        dmOwnerEmail: userEmail,
        channelName: `Direct Message - ${userEmail}`,
        agentId,
      });
      if (!binding) {
        if (requireNoExistingBinding) {
          throw new ApiError(
            409,
            "The direct message assignment already exists. Reload the channels and try again.",
          );
        }
        const concurrentDm =
          await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
            organizationId: request.organizationId,
            provider,
            dmOwnerEmail: userEmail,
          });
        if (!concurrentDm) {
          throw new ApiError(
            409,
            "Cannot connect this direct message because the provider identity has another pending connection. Remove that connection, then try again.",
          );
        }
        const updated =
          await ChatOpsChannelBindingModel.updateByIdAndOrganization({
            id: concurrentDm.id,
            organizationId: request.organizationId,
            input: { agentId },
          });
        if (!updated) {
          throw new ApiError(500, "Failed to update DM binding");
        }
        return reply.send({
          ...updated,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        });
      }

      return reply.send({
        ...binding,
        createdAt: binding.createdAt.toISOString(),
        updatedAt: binding.updatedAt.toISOString(),
      });
    },
  );

  /**
   * Apply every assignment, channel setting, and pending DM selected for one
   * agent. The model locks and commits the complete plan as one transaction.
   */
  fastify.post(
    "/api/chatops/bindings/assignment-plan",
    {
      schema: {
        operationId: RouteId.ApplyChatOpsBindingPlan,
        description:
          "Atomically apply ChatOps assignments, channel settings, and pending direct-message bindings for an agent",
        tags: ["ChatOps"],
        body: ChatOpsAssignmentPlanSchema,
        response: constructResponseSchema(
          z.array(ChatOpsChannelBindingResponseSchema),
        ),
      },
    },
    async (request, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { agent: ["admin"] },
        request.headers,
      );
      const targetAgent = await AgentModel.findById(
        request.body.targetAgentId,
        request.user.id,
        isAgentAdmin,
      );
      if (
        !targetAgent ||
        targetAgent.organizationId !== request.organizationId
      ) {
        throw new ApiError(404, "Agent not found");
      }
      for (const { provider } of request.body.directMessages) {
        await assertMessagingChannelAllowed({
          organizationId: request.organizationId,
          channel: provider,
        });
      }
      if (request.body.directMessages.length > 0) {
        const { success: canCreateAgentTrigger } = await hasPermission(
          { agentTrigger: ["create"] },
          request.headers,
        );
        if (!canCreateAgentTrigger) {
          throw new ApiError(403, "Forbidden");
        }
      }
      const bindings = await ChatOpsChannelBindingModel.applyAssignmentPlan({
        organizationId: request.organizationId,
        userId: request.user.id,
        dmOwnerEmail: request.user.email,
        ...request.body,
      });

      await Promise.all(
        bindings.map((binding) =>
          invalidateChannelAnswerAll({
            provider: binding.provider,
            channelId: binding.channelId,
            workspaceId: binding.workspaceId,
          }),
        ),
      );

      return reply.send(
        bindings.map((binding) => ({
          ...binding,
          createdAt: binding.createdAt.toISOString(),
          updatedAt: binding.updatedAt.toISOString(),
        })),
      );
    },
  );

  /**
   * Bulk-update agent assignment for multiple channel bindings
   */
  fastify.patch(
    "/api/chatops/bindings",
    {
      schema: {
        operationId: RouteId.BulkUpdateChatOpsBindings,
        description:
          "Bulk-update agent assignment for multiple channel bindings",
        tags: ["ChatOps"],
        body: z
          .object({
            ids: z.array(z.string().uuid()).min(1).max(500),
            agentId: z.string().uuid().nullable(),
            expectedAgentAssignments: z
              .array(
                z.object({
                  id: z.string().uuid(),
                  agentId: z.string().uuid().nullable(),
                }),
              )
              .min(1)
              .max(500)
              .optional(),
          })
          .superRefine(({ ids, expectedAgentAssignments }, ctx) => {
            if (!expectedAgentAssignments) return;
            const expectedIds = new Set(
              expectedAgentAssignments.map((assignment) => assignment.id),
            );
            if (
              expectedIds.size !== ids.length ||
              ids.some((id) => !expectedIds.has(id))
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["expectedAgentAssignments"],
                message: "Expected assignments must cover each binding ID once",
              });
            }
          }),
        response: constructResponseSchema(
          z.array(ChatOpsChannelBindingResponseSchema),
        ),
      },
    },
    async (request, reply) => {
      const { ids, agentId, expectedAgentAssignments } = request.body;

      // Validate personal agent cannot be assigned to channel bindings
      if (agentId) {
        // Fetch all bindings to check which are DMs
        const bindings = await ChatOpsChannelBindingModel.findByIds(
          ids,
          request.organizationId,
        );
        const hasChannelBindings = bindings.some((b) => !b.isDm);
        if (hasChannelBindings) {
          await validateAgentChannelAssignment({
            agentId,
            isDm: false,
            userId: request.user.id,
            userEmail: request.user.email,
            organizationId: request.organizationId,
          });
        }
        // For DM bindings, validate the user owns them
        const dmBindings = bindings.filter((b) => b.isDm);
        if (dmBindings.length > 0) {
          await validateAgentChannelAssignment({
            agentId,
            isDm: true,
            userId: request.user.id,
            userEmail: request.user.email,
            dmOwnerEmails: dmBindings.map((binding) => binding.dmOwnerEmail),
            organizationId: request.organizationId,
          });
        }
      }

      const updated = await ChatOpsChannelBindingModel.bulkUpdateAgent({
        ids,
        organizationId: request.organizationId,
        agentId,
        expectedAgentAssignments,
      });
      if (!updated) {
        throw new ApiError(
          409,
          "Channel assignments changed. Reload the channels and try again.",
        );
      }

      return reply.send(
        updated.map((b) => ({
          ...b,
          createdAt: b.createdAt.toISOString(),
          updatedAt: b.updatedAt.toISOString(),
        })),
      );
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
      await assertMessagingChannelAllowed({
        organizationId: request.organizationId,
        channel: "ms-teams",
      });

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

      // Validate credentials by requesting an OAuth token from Azure AD
      if (merged.enabled && merged.appId && merged.appSecret) {
        try {
          const creds = new MicrosoftAppCredentials(
            merged.appId,
            merged.appSecret,
            merged.tenantId || undefined,
          );
          await creds.getToken();
        } catch {
          throw new ApiError(
            400,
            "Invalid MS Teams credentials — could not authenticate with Azure AD. Please check your App ID, App Secret, and Tenant ID.",
          );
        }
      }

      await ChatOpsConfigModel.saveMsTeamsConfig(merged);
      await chatOpsManager.reinitialize();

      return reply.send({ success: true });
    },
  );
  /**
   * Connect an ngrok tunnel so this instance is reachable from the Internet.
   * Persists the auth token and brings the tunnel up live — no restart needed.
   */
  fastify.put(
    "/api/chatops/config/ngrok",
    {
      schema: {
        operationId: RouteId.ConnectNgrok,
        description: "Connect an ngrok tunnel for inbound chatops webhooks",
        tags: ["ChatOps"],
        body: z.object({
          // Omitted = reuse the saved token (reconnect after a Stop).
          authToken: z.string().max(512).optional(),
          domain: z.string().max(256).optional(),
        }),
        response: constructResponseSchema(
          z.object({ success: z.boolean(), domain: z.string() }),
        ),
      },
    },
    async (request, reply) => {
      const { domain } = request.body;
      const authToken =
        request.body.authToken ||
        (await ChatOpsConfigModel.getNgrokConfig())?.authToken;
      if (!authToken) {
        throw new ApiError(
          400,
          "No ngrok auth token provided and none is saved — enter a token.",
        );
      }

      let publicDomain: string;
      try {
        publicDomain = await ngrokTunnelManager.start({ authToken, domain });
      } catch (error) {
        logger.error({ err: error }, "Failed to start ngrok tunnel");
        throw new ApiError(
          400,
          "Could not start the ngrok tunnel — please check your auth token (and reserved domain, if set).",
        );
      }

      return reply.send({ success: true, domain: publicDomain });
    },
  );
  /**
   * Stop the ngrok tunnel and clear its persisted credentials.
   */
  fastify.delete(
    "/api/chatops/config/ngrok",
    {
      schema: {
        operationId: RouteId.DisconnectNgrok,
        description: "Stop the ngrok tunnel and clear its credentials",
        tags: ["ChatOps"],
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (_request, reply) => {
      await ngrokTunnelManager.stop();
      return reply.send({ success: true });
    },
  );
  /**
   * Read the saved ngrok config for prefilling the connect dialog. The token
   * itself is never returned — only whether one is saved.
   */
  fastify.get(
    "/api/chatops/config/ngrok",
    {
      schema: {
        operationId: RouteId.GetNgrokConfig,
        description: "Get saved ngrok configuration (token redacted)",
        tags: ["ChatOps"],
        response: constructResponseSchema(
          z.object({ hasAuthToken: z.boolean(), domain: z.string() }),
        ),
      },
    },
    async (_request, reply) => {
      const stored = await ChatOpsConfigModel.getNgrokConfig();
      return reply.send({
        hasAuthToken: Boolean(stored?.authToken),
        domain: stored?.domain ?? "",
      });
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
          connectionMode: ChatOpsConnectionModeSchema.optional(),
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
      await assertMessagingChannelAllowed({
        organizationId: request.organizationId,
        channel: "slack",
      });

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

      // Validate bot token by calling auth.test()
      if (merged.enabled && merged.botToken) {
        try {
          const client = new WebClient(merged.botToken);
          await client.auth.test();
        } catch {
          throw new ApiError(
            400,
            "Invalid Slack credentials — could not authenticate with Slack. Please check your Bot Token.",
          );
        }
      }

      // Validate app-level token for socket mode by calling apps.connections.open()
      if (
        merged.enabled &&
        merged.connectionMode === "socket" &&
        merged.appLevelToken
      ) {
        try {
          const client = new WebClient(merged.appLevelToken);
          await client.apps.connections.open();
        } catch {
          throw new ApiError(
            400,
            "Invalid Slack App-Level Token — could not open a Socket Mode connection. Please check your App-Level Token.",
          );
        }
      }

      await ChatOpsConfigModel.saveSlackConfig(merged);
      await chatOpsManager.reinitialize();

      return reply.send({ success: true });
    },
  );

  /**
   * Update Telegram chatops config.
   * Persists to DB and reinitializes the chatops manager (which reloads from DB).
   */
  fastify.put(
    "/api/chatops/config/telegram",
    {
      schema: {
        operationId: RouteId.UpdateTelegramChatOpsConfig,
        description: "Update Telegram chatops configuration",
        tags: ["ChatOps"],
        body: z.object({
          enabled: z.boolean().optional(),
          botToken: z.string().max(256).optional(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      if (!config.chatops.telegramEnabled) {
        throw new ApiError(
          400,
          "The Telegram integration is not enabled on this deployment. Set ARCHESTRA_CHATOPS_TELEGRAM_ENABLED=true (or ARCHESTRA_BETA=true) and restart.",
        );
      }
      await assertMessagingChannelAllowed({
        organizationId: request.organizationId,
        channel: "telegram",
      });
      const { enabled, botToken } = request.body;

      // Merge new values with existing DB config (or defaults for first setup)
      const existing = await ChatOpsConfigModel.getTelegramConfig();
      const merged = {
        enabled: enabled ?? existing?.enabled ?? false,
        botToken: botToken ?? existing?.botToken ?? "",
      };

      // Validate the bot token by calling getMe
      if (merged.enabled && merged.botToken) {
        try {
          const response = await fetch(
            `https://api.telegram.org/bot${merged.botToken}/getMe`,
          );
          const body = (await response.json()) as { ok?: boolean };
          if (!body.ok) throw new Error("getMe returned ok=false");
        } catch {
          throw new ApiError(
            400,
            "Invalid Telegram credentials — could not authenticate with Telegram. Please check your Bot Token.",
          );
        }
      }

      await ChatOpsConfigModel.saveTelegramConfig(merged);
      await chatOpsManager.reinitialize();

      return reply.send({ success: true });
    },
  );

  /**
   * Mint a one-shot Telegram linking code for the signed-in user.
   * The code rides a t.me/<bot>?start=<code> deep link; when the user taps
   * Start, the bot redeems it and ties that Telegram chat to this user's
   * email. Open to any authenticated user (self-service).
   */
  fastify.post(
    "/api/chatops/telegram/link-code",
    {
      schema: {
        operationId: RouteId.GenerateTelegramLinkCode,
        description:
          "Generate a one-shot code that links the current user's Telegram account via a t.me deep link",
        tags: ["ChatOps"],
        response: constructResponseSchema(
          z.object({ code: z.string(), botUsername: z.string() }),
        ),
      },
    },
    async (request, reply) => {
      if (!config.chatops.telegramEnabled) {
        throw new ApiError(
          400,
          "The Telegram integration is not enabled on this deployment.",
        );
      }
      const botUsername = chatOpsManager
        .getTelegramProvider()
        ?.getBotUsername();
      if (!botUsername) {
        throw new ApiError(400, "Telegram is not configured yet.");
      }

      const code = randomUUID();
      await cacheManager.set(
        `${CacheKey.TelegramLinkCode}-${code}`,
        { email: request.user.email },
        TELEGRAM_LINK_CODE_TTL_MS,
      );

      return reply.send({ code, botUsername });
    },
  );

  /**
   * Link the signed-in user's Telegram account.
   * The code comes from the bot's /start reply and proves control of the
   * Telegram chat; the email comes from the web session — so neither side
   * can be spoofed. Open to any authenticated user (self-service).
   */
  fastify.post(
    "/api/chatops/telegram/link",
    {
      schema: {
        operationId: RouteId.LinkTelegramChatOpsAccount,
        description:
          "Link the current user's Telegram account using a code from the bot",
        tags: ["ChatOps"],
        body: z.object({ code: z.string().uuid() }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      if (!config.chatops.telegramEnabled) {
        throw new ApiError(
          400,
          "The Telegram integration is not enabled on this deployment.",
        );
      }

      const payload = await cacheManager.getAndDelete<{ chatId?: string }>(
        `${CacheKey.TelegramLinkCode}-${request.body.code}`,
      );
      // Codes minted by the web UI carry an email instead of a chatId and are
      // only redeemable from the bot side — reject them here.
      if (!payload?.chatId) {
        throw new ApiError(
          400,
          "This linking code is invalid or expired. Send /start to the bot again to get a fresh link.",
        );
      }

      const email = request.user.email;
      const chatBinding = await ChatOpsChannelBindingModel.findByChannel({
        provider: "telegram",
        channelId: payload.chatId,
        workspaceId: null,
      });
      if (
        chatBinding?.dmOwnerEmail &&
        chatBinding.dmOwnerEmail.toLowerCase() !== email.toLowerCase()
      ) {
        throw new ApiError(
          400,
          "This Telegram account is already linked to another user.",
        );
      }

      if (!chatBinding) {
        // Reuse the user's pending/stale DM binding when one exists so an
        // agent assignment made in the UI survives the link.
        const existingDm =
          await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
            organizationId: request.organizationId,
            provider: "telegram",
            dmOwnerEmail: email,
          });
        if (existingDm) {
          await ChatOpsChannelBindingModel.fulfillDmBinding({
            id: existingDm.id,
            organizationId: request.organizationId,
            realChannelId: payload.chatId,
            workspaceId: null,
          });
        } else {
          await ChatOpsChannelBindingModel.create({
            organizationId: request.organizationId,
            provider: "telegram",
            channelId: payload.chatId,
            isDm: true,
            dmOwnerEmail: email,
            channelName: `Direct Message - ${email}`,
            agentId: null,
          });
        }
      }

      // Confirm in the Telegram chat (non-blocking)
      chatOpsManager
        .getTelegramProvider()
        ?.sendDirectMessage({
          userId: payload.chatId,
          text: `✅ Linked to ${email}. Send me a message to start!`,
        })
        .catch(() => {});

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
  credentials?: {
    botToken?: string;
    appId?: string;
    appSecret?: string;
    tenantId?: string;
    signingSecret?: string;
    appLevelToken?: string;
    connectionMode?: ChatOpsConnectionMode;
  };
  dmInfo?: {
    botUserId?: string;
    teamId?: string;
    appId?: string;
    botUsername?: string;
  };
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
      const credentials = {
        botToken: maskValue(dbConfig?.botToken ?? ""),
        appId: maskValue(dbConfig?.appId ?? ""),
        connectionMode: (dbConfig?.connectionMode ??
          SLACK_DEFAULT_CONNECTION_MODE) as ChatOpsConnectionMode,
        ...(isSocket
          ? { appLevelToken: maskValue(dbConfig?.appLevelToken ?? "") }
          : { signingSecret: dbConfig?.signingSecret ? "••••••••" : "" }),
      };
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
    case "telegram": {
      const provider = chatOpsManager.getTelegramProvider();
      const dbConfig = await ChatOpsConfigModel.getTelegramConfig();
      return {
        id: "telegram",
        displayName: "Telegram",
        configured: provider?.isConfigured() ?? false,
        credentials: {
          botToken: maskValue(dbConfig?.botToken ?? ""),
        },
        // The bot username builds t.me deep links (chat and account linking)
        dmInfo: provider?.getBotUsername()
          ? { botUsername: provider.getBotUsername() ?? undefined }
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
 * Validate that a personal agent is not assigned to a shared channel.
 * Personal agents may only be assigned to DM bindings owned by the agent's author.
 */
async function validateAgentChannelAssignment(params: {
  agentId: string;
  isDm: boolean;
  userId: string;
  userEmail: string;
  dmOwnerEmails?: Array<string | null>;
  organizationId: string;
}): Promise<void> {
  const agent = (
    await AgentModel.findByIdsForPermissionCheck(
      [params.agentId],
      params.organizationId,
    )
  ).get(params.agentId);
  if (!agent) {
    throw new ApiError(404, "Agent not found");
  }

  if (agent.agentType !== "agent") {
    throw new ApiError(400, "Only internal agents can be assigned to ChatOps.");
  }

  if (agent.scope !== "personal") return;

  if (!params.isDm) {
    throw new ApiError(
      400,
      "Personal agents cannot be assigned to channels. Use an org-scoped or team-scoped agent instead.",
    );
  }

  // For DMs, only the author can assign their own personal agent
  if (agent.authorId !== params.userId) {
    throw new ApiError(
      403,
      "You can only assign your own personal agents to your DM.",
    );
  }
  if (
    params.dmOwnerEmails?.some(
      (ownerEmail) =>
        ownerEmail?.toLowerCase() !== params.userEmail.toLowerCase(),
    )
  ) {
    throw new ApiError(
      403,
      "Personal agents can only be assigned to your own direct messages.",
    );
  }
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
  isDm: boolean;
}): Promise<void> {
  const agents = await chatOpsManager.getAccessibleChatopsAgents({
    senderEmail: params.message.senderEmail,
    isDm: params.isDm,
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
      `Agent **${agent.name}** is now assigned to this ${isTeamsDm ? "conversation" : "channel"}. Processing your message...`,
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
        // Send agent response via turn context (ensures correct thread).
        // This path composes the reply itself instead of going through
        // sendReply, so it owes the same "exactly one footer" guarantee: build
        // the footer from the one helper that defines it, and drop the model's
        // own sign-off before appending it.
        const footer = buildAgentFooter(agent.name);
        await context.sendActivity(
          `${stripDuplicateAgentFooter(result.agentResponse, footer)}\n\n---\n\n${footer}`,
        );
      } else if (!result.success && result.error) {
        // Send error message via turn context (ensures correct thread)
        const errorMessage = getSecurityErrorMessage(result.error);
        await context.sendActivity(`⚠️ **Access Denied**\n\n${errorMessage}`);
      }
    }
  } else {
    await context.sendActivity(
      `Agent **${agent.name}** is now assigned to this ${isTeamsDm ? "conversation" : "channel"}.\n` +
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
 * Canonicalize a Teams message's workspaceId to the team's aadGroupId — the id
 * channel bindings are stored under — assigning it onto the message and
 * returning it.
 *
 * Bot Framework frequently delivers the thread-format `team.id` instead, and
 * only a Bot Framework call can map it. The mapping never changes for a team, so
 * it is cached: the channel gate consults it for every un-mentioned message, and
 * a network round trip per message would defeat the point of gating early.
 * Already-canonical ids and group chats (no team at all) short-circuit.
 */
async function resolveTeamsWorkspaceId(
  context: TurnContext,
  message: IncomingChatMessage,
): Promise<string | null> {
  const resolved = await resolveTeamsAadGroupId(
    context,
    message.workspaceId ?? null,
  );
  if (resolved) message.workspaceId = resolved;
  return resolved;
}

/**
 * The lookup behind resolveTeamsWorkspaceId, taking the raw id directly so
 * activities that never become an IncomingChatMessage — a reaction, say — can
 * resolve the same binding key.
 */
async function resolveTeamsAadGroupId(
  context: TurnContext,
  raw: string | null,
): Promise<string | null> {
  if (!raw || isUuid(raw)) return raw ?? null;

  const cacheKey: AllowedCacheKey = `${CacheKey.TeamsTeamAadGroupId}-${raw}`;
  const cached = await cacheManager.get<string>(cacheKey);
  if (cached) return cached;

  let resolved = raw;
  try {
    // Uses RSC permissions — no Azure AD app permissions needed.
    const teamDetails = await TeamsInfo.getTeamDetails(context);
    if (teamDetails?.aadGroupId) resolved = teamDetails.aadGroupId;
  } catch {
    // Non-fatal — group chats don't have team details
  }

  // A team whose details can't be read (RSC consent not granted yet) is cached
  // too, on a much shorter TTL. Without that it would pay a Bot Framework round
  // trip on every un-mentioned message; with a short window it still picks up
  // the real id soon after an owner consents.
  await cacheManager.set(
    cacheKey,
    resolved,
    resolved === raw
      ? TEAMS_AAD_GROUP_ID_RETRY_TTL_MS
      : TEAMS_AAD_GROUP_ID_TTL_MS,
  );
  return resolved;
}

/**
 * Mute a Teams channel thread, confirming only when the mute changed something
 * — a cleared activation, or a first mute in an answer-all channel (see
 * muteChannelThreadAndNotify). Redelivered reaction activities and repeat mutes
 * find the state already set and stay silent, so no duplicate "muted" notices.
 */
async function muteTeamsThreadAndNotify(
  context: TurnContext,
  activation: { provider: "ms-teams"; channelId: string; threadId: string },
): Promise<void> {
  await muteChannelThreadAndNotify({
    ...activation,
    resolveAnswerAll: async () =>
      await isChannelAnswerAllEnabled({
        provider: activation.provider,
        channelId: activation.channelId,
        // Bindings are keyed on the team's aadGroupId, so a reaction has to
        // canonicalize the raw team id exactly as the message path does or the
        // setting reads as off and an answer-all mute goes unconfirmed.
        workspaceId: await resolveTeamsAadGroupId(
          context,
          context.activity.channelData?.team?.aadGroupId ??
            context.activity.channelData?.team?.id ??
            null,
        ),
      }),
    postMutedNotice: async () => {
      await context.sendActivity(buildThreadMutedNotice());
    },
  });
}

/**
 * Resolve sender email (TeamsInfo → Graph API fallback) and verify they are a registered Archestra user.
 * Sets message.senderEmail and returns true if verified, false if rejected.
 *
 * `announce` controls whether a rejection or a first-time auto-provision is
 * explained in the conversation. It must be false for a message that reached us
 * only because the channel answers every message: Teams has no ephemeral
 * messages, so every notice is public, and someone who never addressed the bot
 * has not asked to be onboarded by it. Provisioning still happens either way —
 * only the announcements are withheld.
 */
async function resolveAndVerifySenderForMSTeams(params: {
  context: TurnContext;
  provider: { getUserEmail(aadObjectId: string): Promise<string | null> };
  message: IncomingChatMessage;
  announce: boolean;
}): Promise<boolean> {
  const { context, provider, message, announce } = params;
  const notify = async (text: string) => {
    if (announce) await context.sendActivity(text);
  };

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
    await notify(
      "Could not verify your identity. Please ensure the bot is properly installed in your team or chat.",
    );
    return false;
  }

  let user = await UserModel.findByEmail(message.senderEmail.toLowerCase());
  if (!user) {
    // Auto-provision: create user + member from Teams identity
    try {
      await autoProvisionUser({
        email: message.senderEmail,
        name: message.senderName,
        provider: "ms-teams",
      });
      user = await UserModel.findByEmail(message.senderEmail.toLowerCase());
      if (!user) {
        logger.error(
          { senderEmail: message.senderEmail },
          "[ChatOps] Auto-provisioned user not found after creation",
        );
        await notify(
          "Something went wrong while setting up your account. Please try again.",
        );
        return false;
      }

      // In channels, don't expose the signup link — ask user to DM the bot.
      // In DMs, the signup link is sent later (before the agent selection card).
      const isDm =
        context.activity.conversation?.conversationType === "personal";
      const welcomeMode =
        announce && !isDm ? await resolveSignupWelcomeMode() : "none";
      if (welcomeMode !== "none") {
        const botId = context.activity.recipient.id;
        const dmDeepLink = `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(botId)}`;
        const appName = await OrganizationModel.getAppName();
        const nextStep =
          welcomeMode === "login"
            ? `To use the ${appName} web app, send me a direct message and I'll send you a sign-in link.`
            : `To finish signing up so you can use the ${appName} web app, send me a direct message and I'll send you a link to finish signing up.`;
        await context
          .sendActivity(
            `Hey there 👋 We created a ${appName} user for you (${message.senderEmail}). ` +
              `${nextStep}\n\n` +
              `[Open DM with me](${dmDeepLink})`,
          )
          .catch(() => {});
      }

      logger.info(
        { senderEmail: message.senderEmail },
        "[ChatOps] Auto-provisioned user from Teams",
      );
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "[ChatOps] Failed to auto-provision user from Teams",
      );
      await notify(
        "Something went wrong while setting up your account. Please try again.",
      );
      return false;
    }
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
  // white-label-ok: matches the internal sentinel thrown by the incoming-email
  // authorizer, not copy — the branded sentence is built on the next line.
  if (error.includes("not a registered Archestra user")) {
    // Extract email from error message if present
    const emailMatch = error.match(/Unauthorized: (.+?) is not/);
    const email = emailMatch?.[1] || "Your email";
    return `${email} is not a registered ${archestraMcpBranding.appName} user. Contact your administrator for access.`;
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

/**
 * How long a team's resolved aadGroupId stays cached (see
 * resolveTeamsWorkspaceId). A team's aadGroupId is immutable, so this can be
 * generous.
 */
const TEAMS_AAD_GROUP_ID_TTL_MS = TimeInMs.Day;

/**
 * How long an UNRESOLVED team id stays cached. Short, because the next attempt
 * may succeed — it bounds both how often a team with no readable details costs a
 * Bot Framework round trip and how long it keeps using the fallback id.
 */
const TEAMS_AAD_GROUP_ID_RETRY_TTL_MS = 5 * TimeInMs.Minute;
