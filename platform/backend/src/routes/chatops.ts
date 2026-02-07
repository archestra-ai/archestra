import { RouteId } from "@shared";
import { TeamsInfo, TurnContext } from "botbuilder";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import {
  CHATOPS_COMMANDS,
  CHATOPS_RATE_LIMIT,
} from "@/agents/chatops/constants";
import { isRateLimited } from "@/agents/utils";
import { type AllowedCacheKey, CacheKey } from "@/cache-manager";
import logger from "@/logging";
import {
  AgentModel,
  ChatOpsChannelBindingModel,
  OrganizationModel,
  UserModel,
} from "@/models";
import { ApiError, constructResponseSchema } from "@/types";
import {
  type ChatOpsProviderType,
  ChatOpsProviderTypeSchema,
  type IncomingChatMessage,
} from "@/types/chatops";
import { ChatOpsChannelBindingResponseSchema } from "@/types/chatops-channel-binding";

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
          400: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
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

            // Parse the activity into our message format
            const message = await provider.parseWebhookNotification(
              context.activity,
              headers,
            );

            if (!message) {
              // Not a processable message (e.g., system event)
              return;
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
              await sendAgentSelectionCard(context, message);
              return;
            }

            // Check for existing binding
            const binding = await ChatOpsChannelBindingModel.findByChannel({
              provider: "ms-teams",
              channelId: message.channelId,
              workspaceId: message.workspaceId,
            });

            if (!binding) {
              // No binding - show agent selection
              await sendAgentSelectionCard(context, message);
              return;
            }

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
              }),
            ),
          }),
        ),
      },
    },
    async (_, reply) => {
      // Iterate through all provider types - automatically includes new providers
      // TypeScript exhaustiveness in getProviderInfo() ensures new providers are handled
      const providers = ChatOpsProviderTypeSchema.options.map(getProviderInfo);

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

      return reply.send(
        bindings.map((b) => ({
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
 * Uses exhaustive switch to force updates when new providers are added.
 */
function getProviderInfo(providerType: ChatOpsProviderType): {
  id: ChatOpsProviderType;
  displayName: string;
  configured: boolean;
} {
  switch (providerType) {
    case "ms-teams": {
      const provider = chatOpsManager.getMSTeamsProvider();
      return {
        id: "ms-teams",
        displayName: "Microsoft Teams",
        configured: provider?.isConfigured() ?? false,
      };
    }
    // When adding new providers, TypeScript will error here until handled
  }
}

/**
 * Send an Adaptive Card for agent selection
 */
async function sendAgentSelectionCard(
  context: TurnContext,
  message: IncomingChatMessage,
): Promise<void> {
  // Get available agents for MS Teams, filtered by user access
  const agents = await chatOpsManager.getAccessibleChatopsAgents({
    provider: "ms-teams",
    senderEmail: message.senderEmail,
  });

  if (agents.length === 0) {
    await context.sendActivity(
      "No agents are available for you in Microsoft Teams.\n" +
        "Contact your administrator to get access to an agent with Teams enabled.",
    );
    return;
  }

  // Build choices for the dropdown
  const choices = agents.map((agent) => ({
    title: agent.name,
    value: agent.id,
  }));

  // Check for existing binding to pre-select
  const existingBinding = await ChatOpsChannelBindingModel.findByChannel({
    provider: "ms-teams",
    channelId: message.channelId,
    workspaceId: message.workspaceId,
  });

  // Build card body based on whether this is first-time setup or changing agent
  const cardBody = existingBinding
    ? [
        {
          type: "TextBlock",
          size: "Medium",
          weight: "Bolder",
          text: "Change Default Agent",
        },
        {
          type: "TextBlock",
          text: "Select a different agent to handle messages in this channel:",
          wrap: true,
        },
        {
          type: "Input.ChoiceSet",
          id: "agentId",
          style: "compact",
          value: existingBinding.agentId,
          choices,
        },
      ]
    : [
        {
          type: "TextBlock",
          weight: "Bolder",
          text: "Welcome to Archestra!",
        },
        {
          type: "TextBlock",
          text: "Each Microsoft Teams channel needs a **default agent** bound to it. This agent will handle all your requests in this channel by default.",
          wrap: true,
          spacing: "Small",
        },
        {
          type: "TextBlock",
          text: "**Tip:** You can use other agents with the syntax **AgentName >** (e.g., @Archestra Sales > what's the status?).",
          wrap: true,
          spacing: "Small",
        },
        {
          type: "TextBlock",
          text: "**Available commands:**",
          wrap: true,
          spacing: "Medium",
        },
        {
          type: "FactSet",
          spacing: "Small",
          facts: [
            {
              title: "/select-agent",
              value:
                "Change the default agent handling requests in the channel",
            },
            {
              title: "/status",
              value: "Check the current agent handling requests in the channel",
            },
            { title: "/help", value: "Show available commands" },
          ],
        },
        {
          type: "TextBlock",
          text: "**Let's set the default agent for this channel:**",
          wrap: true,
          spacing: "Medium",
        },
        {
          type: "Input.ChoiceSet",
          id: "agentId",
          style: "compact",
          value: choices[0]?.value || "",
          choices,
        },
      ];

  // Send Adaptive Card
  const card = {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: cardBody,
    actions: [
      {
        type: "Action.Submit",
        title: "Confirm Selection",
        data: {
          action: "selectAgent",
          channelId: message.channelId,
          workspaceId: message.workspaceId,
          // Include original message so we can process it after binding
          originalMessageText: message.text || undefined,
        },
      },
    ],
  };

  await context.sendActivity({
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: card,
      },
    ],
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

  // Verify the agent exists and allows MS Teams
  const agent = await AgentModel.findById(agentId);
  if (!agent) {
    await context.sendActivity(
      "The selected agent no longer exists. Please try again.",
    );
    return;
  }

  if (!agent.allowedChatops?.includes("ms-teams")) {
    await context.sendActivity(
      `The agent "${agent.name}" is no longer available for Microsoft Teams. Please select a different agent.`,
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

  // Create or update the binding
  await ChatOpsChannelBindingModel.upsertByChannel({
    organizationId,
    provider: "ms-teams",
    channelId: channelId || message.channelId,
    workspaceId: workspaceId || message.workspaceId,
    agentId,
  });

  logger.debug("[ChatOps] handleAgentSelection: binding upserted");

  // If there was an original message (not a command), process it now
  if (originalMessageText && !isCommand(originalMessageText)) {
    logger.debug(
      { originalMessageText },
      "[ChatOps] handleAgentSelection: about to send 'processing' message",
    );
    await context.sendActivity(
      `Agent **${agent.name}** is now bound to this channel. Processing your message...`,
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
          `${result.agentResponse}\n\n---\n_Via ${agent.name}_`,
        );
      } else if (!result.success && result.error) {
        // Send error message via turn context (ensures correct thread)
        const errorMessage = getSecurityErrorMessage(result.error);
        await context.sendActivity(`⚠️ **Access Denied**\n\n${errorMessage}`);
      }
    }
  } else {
    await context.sendActivity(
      `Agent **${agent.name}** is now bound to this channel.\n` +
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
    logger.warn(
      { senderEmail: message.senderEmail },
      "[ChatOps] Sender is not a registered Archestra user",
    );
    await context.sendActivity(
      `You (${message.senderEmail}) are not a registered Archestra user. Contact your administrator for access.`,
    );
    return false;
  }

  return true;
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
