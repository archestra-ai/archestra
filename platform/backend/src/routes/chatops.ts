import { RouteId } from "@shared";
import type { TurnContext } from "botbuilder";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import {
  CHATOPS_COMMANDS,
  CHATOPS_RATE_LIMIT,
} from "@/agents/chatops/constants";
import { CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import {
  ChatOpsChannelBindingModel,
  OrganizationModel,
  PromptModel,
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
      if (await isRateLimited(clientIp)) {
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

            // Check for commands
            const trimmedText = message.text.trim().toLowerCase();

            if (trimmedText === CHATOPS_COMMANDS.HELP) {
              await context.sendActivity(
                "Available commands:\n" +
                  "• `/select-agent` - Change which agent handles this channel\n" +
                  "• `/status` - Show current agent binding for this channel\n" +
                  "• `/help` - Show this help message\n\n" +
                  "Or just send a message to interact with the bound agent.",
              );
              return;
            }

            if (trimmedText === CHATOPS_COMMANDS.STATUS) {
              const binding = await ChatOpsChannelBindingModel.findByChannel({
                provider: "ms-teams",
                channelId: message.channelId,
                workspaceId: message.workspaceId,
              });

              if (binding) {
                const prompt = await PromptModel.findById(binding.promptId);
                await context.sendActivity(
                  `This channel is bound to agent: **${prompt?.name || binding.promptId}**\n` +
                    `Use \`/select-agent\` to change the binding.`,
                );
              } else {
                await context.sendActivity(
                  "No agent is bound to this channel yet.\n" +
                    "Send any message to set up an agent binding.",
                );
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

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/**
 * Check if an IP is rate limited using the shared CacheManager
 */
async function isRateLimited(ip: string): Promise<boolean> {
  const now = Date.now();
  const cacheKey = `${CacheKey.WebhookRateLimit}-chatops-${ip}` as const;
  const entry = await cacheManager.get<RateLimitEntry>(cacheKey);

  if (!entry || now - entry.windowStart > CHATOPS_RATE_LIMIT.WINDOW_MS) {
    await cacheManager.set(
      cacheKey,
      { count: 1, windowStart: now },
      CHATOPS_RATE_LIMIT.WINDOW_MS * 2,
    );
    return false;
  }

  if (entry.count >= CHATOPS_RATE_LIMIT.MAX_REQUESTS) {
    return true;
  }

  await cacheManager.set(
    cacheKey,
    { count: entry.count + 1, windowStart: entry.windowStart },
    CHATOPS_RATE_LIMIT.WINDOW_MS * 2,
  );
  return false;
}

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
  // Get available prompts (agents in UI) for MS Teams
  const prompts = await PromptModel.findByAllowedChatopsProvider(
    "ms-teams" as ChatOpsProviderType,
  );

  if (prompts.length === 0) {
    await context.sendActivity(
      "No agents are configured for Microsoft Teams.\n" +
        "Please ask your administrator to enable Teams in the agent settings.",
    );
    return;
  }

  // Build choices for the dropdown
  const choices = prompts.map((prompt) => ({
    title: prompt.name,
    value: prompt.id,
  }));

  // Check for existing binding to pre-select
  const existingBinding = await ChatOpsChannelBindingModel.findByChannel({
    provider: "ms-teams",
    channelId: message.channelId,
    workspaceId: message.workspaceId,
  });

  // Send Adaptive Card
  const card = {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        size: "Medium",
        weight: "Bolder",
        text: existingBinding ? "Change Agent" : "Welcome! Select an Agent",
      },
      {
        type: "TextBlock",
        text: existingBinding
          ? "Select a different agent to handle messages in this channel:"
          : "No agent is bound to this channel yet. Select an agent to handle messages here:",
        wrap: true,
      },
      {
        type: "Input.ChoiceSet",
        id: "promptId",
        style: "compact",
        value: existingBinding?.promptId || "",
        choices,
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Confirm Selection",
        data: {
          action: "selectAgent",
          channelId: message.channelId,
          workspaceId: message.workspaceId,
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
    | { promptId?: string; channelId?: string; workspaceId?: string }
    | undefined;
  const { promptId, channelId, workspaceId } = value || {};

  if (!promptId) {
    await context.sendActivity("Please select an agent from the dropdown.");
    return;
  }

  // Verify the prompt exists and allows MS Teams
  const prompt = await PromptModel.findById(promptId);
  if (!prompt) {
    await context.sendActivity(
      "The selected agent no longer exists. Please try again.",
    );
    return;
  }

  if (!prompt.allowedChatops?.includes("ms-teams")) {
    await context.sendActivity(
      `The agent "${prompt.name}" is no longer available for Microsoft Teams. Please select a different agent.`,
    );
    return;
  }

  // Get the default organization
  const organizationId = await getDefaultOrganizationId();

  // Create or update the binding
  await ChatOpsChannelBindingModel.upsertByChannel({
    organizationId,
    provider: "ms-teams",
    channelId: channelId || message.channelId,
    workspaceId: workspaceId || message.workspaceId,
    promptId,
  });

  await context.sendActivity(
    `Agent **${prompt.name}** is now bound to this channel.\n` +
      "Send a message (with @mention) to start interacting!",
  );
}
