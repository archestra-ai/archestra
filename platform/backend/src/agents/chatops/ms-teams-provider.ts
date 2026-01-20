import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import {
  ActivityTypes,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  type ConversationReference,
  TurnContext,
} from "botbuilder";
import { PasswordServiceClientCredentialFactory } from "botframework-connector";
import config from "@/config";
import logger from "@/logging";
import type {
  ChatOpsProvider,
  ChatOpsProviderType,
  ChatReplyOptions,
  ChatThreadMessage,
  IncomingChatMessage,
  ThreadHistoryParams,
} from "@/types/chatops";
import { CHATOPS_THREAD_HISTORY } from "./constants";

/**
 * MS Teams provider implementation using Bot Framework SDK.
 *
 * Security:
 * - JWT validation is handled automatically by CloudAdapter
 * - App ID and Password are validated on every request
 * - Supports both single-tenant and multi-tenant Azure Bot configurations
 * - No external API token needed - uses internal executeA2AMessage()
 */
class MSTeamsProvider implements ChatOpsProvider {
  readonly providerId: ChatOpsProviderType = "ms-teams";
  readonly displayName = "Microsoft Teams";

  private adapter: CloudAdapter | null = null;
  private graphClient: Client | null = null;

  /**
   * Check if MS Teams is configured
   */
  isConfigured(): boolean {
    const { enabled, appId, appPassword } = config.chatops.msTeams;
    return enabled && Boolean(appId) && Boolean(appPassword);
  }

  /**
   * Initialize the Bot Framework adapter and Graph client
   */
  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info("[MSTeamsProvider] Not configured, skipping initialization");
      return;
    }

    const { appId, appPassword, tenantId, graph } = config.chatops.msTeams;

    // Create credentials factory - tenantId enables single-tenant auth
    const credentialsFactory = tenantId
      ? new PasswordServiceClientCredentialFactory(appId, appPassword, tenantId)
      : new PasswordServiceClientCredentialFactory(appId, appPassword);

    // Create authentication with optional tenant ID for single-tenant bots
    const auth = new ConfigurationBotFrameworkAuthentication(
      {
        MicrosoftAppId: appId,
        MicrosoftAppTenantId: tenantId || undefined,
      },
      credentialsFactory,
    );

    // Initialize CloudAdapter (replaces deprecated BotFrameworkAdapter)
    this.adapter = new CloudAdapter(auth);

    // Add error handler
    this.adapter.onTurnError = async (_context, error) => {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "[MSTeamsProvider] Bot Framework error",
      );
      // Don't send error messages to users for security reasons
    };

    const tenantMode = tenantId ? "single-tenant" : "multi-tenant";
    logger.info(
      { tenantMode },
      "[MSTeamsProvider] Bot Framework adapter initialized",
    );

    // Initialize Graph client if configured (for thread history)
    if (graph?.tenantId && graph?.clientId && graph?.clientSecret) {
      const credential = new ClientSecretCredential(
        graph.tenantId,
        graph.clientId,
        graph.clientSecret,
      );

      const authProvider = new TokenCredentialAuthenticationProvider(
        credential,
        {
          scopes: ["https://graph.microsoft.com/.default"],
        },
      );

      this.graphClient = Client.initWithMiddleware({
        authProvider,
      });

      logger.info("[MSTeamsProvider] Graph client initialized");
    } else {
      logger.info(
        "[MSTeamsProvider] Graph API not configured, thread history will be unavailable",
      );
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.adapter = null;
    this.graphClient = null;
    logger.info("[MSTeamsProvider] Cleaned up");
  }

  /**
   * Validate webhook request using Bot Framework JWT validation.
   *
   * The actual JWT validation is done by the adapter when processing the activity.
   * This method just checks if we have the required headers.
   */
  async validateWebhookRequest(
    _payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    // Bot Framework requires Authorization header with Bearer token
    const authHeader = headers.authorization || headers.Authorization;
    if (!authHeader) {
      logger.warn("[MSTeamsProvider] Missing Authorization header");
      return false;
    }

    // The actual JWT validation is done by the adapter during processActivity
    // We just check for the presence of the header here
    return true;
  }

  /**
   * Handle validation challenges (not used by Bot Framework, but required by interface)
   */
  handleValidationChallenge(_payload: unknown): unknown | null {
    // Bot Framework doesn't use validation challenges like Graph webhooks
    return null;
  }

  /**
   * Parse a Bot Framework activity into an IncomingChatMessage.
   * Returns null for non-message activities or activities that shouldn't be processed.
   */
  async parseWebhookNotification(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<IncomingChatMessage | null> {
    if (!this.adapter) {
      logger.error(
        "[MSTeamsProvider] Adapter not initialized, cannot parse notification",
      );
      return null;
    }

    // The payload is the Bot Framework activity
    const activity = payload as {
      type?: string;
      id?: string;
      text?: string;
      channelId?: string;
      conversation?: {
        id?: string;
        tenantId?: string;
        conversationType?: string;
      };
      from?: { id?: string; name?: string; aadObjectId?: string };
      recipient?: { id?: string; name?: string };
      timestamp?: string;
      replyToId?: string;
      serviceUrl?: string;
      channelData?: {
        team?: { id?: string };
        channel?: { id?: string };
        tenant?: { id?: string };
      };
    };

    // Only process message activities
    if (activity.type !== ActivityTypes.Message) {
      logger.debug(
        { type: activity.type },
        "[MSTeamsProvider] Ignoring non-message activity",
      );
      return null;
    }

    // Skip if no text content
    if (!activity.text) {
      logger.debug("[MSTeamsProvider] Ignoring message without text");
      return null;
    }

    // Debug: Log raw activity data for thread detection
    logger.debug(
      {
        conversationId: activity.conversation?.id,
        replyToId: activity.replyToId,
        channelDataChannel: activity.channelData?.channel?.id,
        channelDataTeam: activity.channelData?.team?.id,
      },
      "[MSTeamsProvider] Raw activity IDs for thread detection",
    );

    // Extract channel and workspace IDs
    // For Teams, the channel ID is in channelData.channel.id, and team ID is in channelData.team.id
    // The conversation ID may contain ";messageid=xxx" suffix for thread replies - strip it
    let rawChannelId =
      activity.channelData?.channel?.id || activity.conversation?.id;

    // Strip the ";messageid=" suffix if present to get the clean channel ID
    if (rawChannelId?.includes(";messageid=")) {
      rawChannelId = rawChannelId.split(";messageid=")[0];
    }
    const channelId = rawChannelId;

    const workspaceId = activity.channelData?.team?.id || null;

    if (!channelId) {
      logger.warn(
        "[MSTeamsProvider] Cannot determine channel ID from activity",
      );
      return null;
    }

    // Clean bot mention from the text
    const botName = activity.recipient?.name;
    const cleanedText = cleanBotMention(activity.text, botName);

    // If the cleaned text is empty, the message was just a mention with no content
    if (!cleanedText) {
      logger.debug(
        "[MSTeamsProvider] Message has no content after cleaning mentions",
      );
      return null;
    }

    // Detect if this is a thread reply:
    // 1. replyToId is set (explicit reply)
    // 2. conversation.id contains ";messageid=" (Teams thread format)
    const isThreadReply =
      Boolean(activity.replyToId) ||
      Boolean(activity.conversation?.id?.includes(";messageid="));

    const message: IncomingChatMessage = {
      messageId: activity.id || `teams-${Date.now()}`,
      channelId,
      workspaceId,
      threadId: extractThreadId(activity),
      senderId: activity.from?.aadObjectId || activity.from?.id || "unknown",
      senderName: activity.from?.name || "Unknown User",
      text: cleanedText,
      rawText: activity.text,
      timestamp: activity.timestamp ? new Date(activity.timestamp) : new Date(),
      isThreadReply,
      metadata: {
        tenantId:
          activity.channelData?.tenant?.id || activity.conversation?.tenantId,
        serviceUrl: activity.serviceUrl,
        conversationReference: TurnContext.getConversationReference(
          activity as Parameters<
            typeof TurnContext.getConversationReference
          >[0],
        ),
        authHeader: headers.authorization || headers.Authorization,
      },
    };

    return message;
  }

  /**
   * Send a reply to a Teams message
   */
  async sendReply(options: ChatReplyOptions): Promise<string> {
    if (!this.adapter) {
      throw new Error("MSTeamsProvider not initialized");
    }

    const conversationReference = options.conversationReference as
      | ConversationReference
      | undefined;
    if (!conversationReference) {
      // Try to get it from the original message metadata
      const metadataRef = options.originalMessage.metadata
        ?.conversationReference as ConversationReference | undefined;
      if (!metadataRef) {
        throw new Error("No conversation reference available for reply");
      }
      options.conversationReference = metadataRef;
    }

    const ref = (options.conversationReference ||
      options.originalMessage.metadata?.conversationReference) as
      | ConversationReference
      | undefined;
    if (!ref) {
      throw new Error("No conversation reference available for reply");
    }

    let replyText = options.text;

    // Add footer if provided
    if (options.footer) {
      replyText += `\n\n---\n_${options.footer}_`;
    }

    let messageId = "";

    // Use continueConversationAsync (continueConversation is deprecated)
    const botAppId = config.chatops.msTeams.appId;
    await this.adapter.continueConversationAsync(
      botAppId,
      ref,
      async (context) => {
        const response = await context.sendActivity(replyText);
        messageId = response?.id || "";
      },
    );

    return messageId;
  }

  /**
   * Get thread history using Microsoft Graph API
   */
  async getThreadHistory(
    params: ThreadHistoryParams,
  ): Promise<ChatThreadMessage[]> {
    if (!this.graphClient) {
      logger.debug(
        "[MSTeamsProvider] Graph client not configured, cannot fetch thread history",
      );
      return [];
    }

    const limit = Math.min(
      params.limit || CHATOPS_THREAD_HISTORY.DEFAULT_LIMIT,
      CHATOPS_THREAD_HISTORY.MAX_LIMIT,
    );

    try {
      // Detect if this is a group chat or team channel
      // Group chats have IDs like "19:xxx@thread.tacv2" or "19:xxx@thread.v2"
      // Team GUIDs are actual UUIDs like "e6ec2dea-2205-4e2f-afb6-f83e5f588f40"
      const isGroupChat =
        !params.workspaceId ||
        params.workspaceId.startsWith("19:") ||
        params.channelId.includes("@thread");

      let messages: {
        id: string;
        replyToId?: string; // ID of parent message if this is a thread reply
        from?: {
          user?: { id?: string; displayName?: string };
          // Application/connector messages (e.g., Grafana IRM, webhooks)
          application?: { id?: string; displayName?: string };
        };
        body?: { content?: string };
        // Attachments contain Adaptive Cards (used by Grafana IRM, etc.)
        attachments?: {
          contentType?: string;
          content?: string;
          name?: string;
        }[];
        createdDateTime?: string;
      }[];

      if (isGroupChat) {
        // For group chats, use the /chats/{chat-id}/messages endpoint
        // The chat ID is the conversation ID (channelId in our structure)
        // Note: This requires Chat.Read.All application permission

        logger.debug(
          {
            channelId: params.channelId,
            threadId: params.threadId,
            hasThreadId: Boolean(params.threadId),
          },
          "[MSTeamsProvider] Fetching group chat history",
        );

        // If we have a thread ID, fetch only the parent message and its replies
        // This ensures we only see thread context, not other channel messages
        if (params.threadId && !params.threadId.includes("@thread")) {
          // Fetch the parent message directly
          const parentMessage = await this.graphClient
            .api(`/chats/${params.channelId}/messages/${params.threadId}`)
            .get();

          logger.debug(
            {
              parentMessageId: parentMessage?.id,
              hasBody: Boolean(parentMessage?.body?.content),
            },
            "[MSTeamsProvider] Fetched parent message for group chat thread",
          );

          // Try to fetch thread replies (only works for team channels, not group chats)
          try {
            const repliesResponse = await this.graphClient
              .api(
                `/chats/${params.channelId}/messages/${params.threadId}/replies`,
              )
              .top(limit - 1)
              .get();
            const replies = repliesResponse.value || [];

            logger.debug(
              {
                parentMessageId: parentMessage?.id,
                repliesCount: replies.length,
              },
              "[MSTeamsProvider] Fetched thread replies for group chat",
            );

            // Combine: parent message first, then replies
            messages = [parentMessage, ...replies];
          } catch (repliesError) {
            // The /replies endpoint is not supported for group chats.
            // Graph API doesn't provide replyToId for group chat messages either.
            // Best we can do: return just the parent message for context.
            logger.warn(
              {
                error:
                  repliesError instanceof Error
                    ? repliesError.message
                    : String(repliesError),
                threadId: params.threadId,
              },
              "[MSTeamsProvider] Thread replies not available for group chat (API limitation), using parent message only",
            );

            // Use the parent message we already fetched successfully
            messages = [parentMessage];
          }
        } else {
          // No thread ID or it's a channel format - just fetch recent messages
          const response = await this.graphClient
            .api(`/chats/${params.channelId}/messages`)
            .top(limit)
            .get();
          messages = response.value || [];
        }
      } else {
        // For team channels, use the /teams/{teamId}/channels/{channelId}/messages endpoint
        // Note: This requires ChannelMessage.Read.All application permission
        logger.debug(
          { workspaceId: params.workspaceId, channelId: params.channelId },
          "[MSTeamsProvider] Fetching team channel history",
        );

        // Debug: Log thread detection
        logger.debug(
          {
            threadId: params.threadId,
            channelId: params.channelId,
            workspaceId: params.workspaceId,
            isThreadReply:
              params.threadId &&
              params.threadId !== params.channelId &&
              !params.threadId.includes("@thread"),
          },
          "[MSTeamsProvider] Thread detection",
        );

        // Check if this is a thread reply (threadId is set and different from channelId)
        // Channel IDs contain "@thread" (e.g., "19:xxx@thread.tacv2"), thread IDs are message IDs
        const isThreadReply =
          params.threadId &&
          params.threadId !== params.channelId &&
          !params.threadId.includes("@thread");

        if (isThreadReply) {
          logger.debug(
            {
              endpoint: `/teams/${params.workspaceId}/channels/${params.channelId}/messages/${params.threadId}/replies`,
            },
            "[MSTeamsProvider] Fetching thread replies",
          );

          // First, fetch the parent message (the thread starter)
          try {
            const parentResponse = await this.graphClient
              .api(
                `/teams/${params.workspaceId}/channels/${params.channelId}/messages/${params.threadId}`,
              )
              .get();

            // Then fetch thread replies
            const repliesResponse = await this.graphClient
              .api(
                `/teams/${params.workspaceId}/channels/${params.channelId}/messages/${params.threadId}/replies`,
              )
              .top(limit - 1) // Reserve one slot for parent message
              .get();

            // Combine parent + replies (parent first)
            messages = [parentResponse, ...(repliesResponse.value || [])];

            logger.debug(
              {
                parentMessageId: parentResponse.id,
                repliesCount: repliesResponse.value?.length || 0,
              },
              "[MSTeamsProvider] Fetched parent + replies",
            );
          } catch (error) {
            logger.warn(
              {
                error: error instanceof Error ? error.message : String(error),
                threadId: params.threadId,
              },
              "[MSTeamsProvider] Failed to fetch parent message, fetching replies only",
            );
            // Fall back to just replies if parent fetch fails
            const response = await this.graphClient
              .api(
                `/teams/${params.workspaceId}/channels/${params.channelId}/messages/${params.threadId}/replies`,
              )
              .top(limit)
              .get();
            messages = response.value || [];
          }
        } else {
          logger.debug(
            {
              endpoint: `/teams/${params.workspaceId}/channels/${params.channelId}/messages`,
            },
            "[MSTeamsProvider] Fetching channel messages (not a thread)",
          );
          // Fetch recent channel messages
          const response = await this.graphClient
            .api(
              `/teams/${params.workspaceId}/channels/${params.channelId}/messages`,
            )
            .top(limit)
            .get();
          messages = response.value || [];
        }
      }

      // Debug: Log raw messages from Graph API
      logger.debug(
        {
          messageCount: messages.length,
          messages: messages.map((msg) => ({
            id: msg.id,
            fromUser: msg.from?.user?.displayName,
            fromApp: msg.from?.application?.displayName,
            bodyContent: msg.body?.content?.substring(0, 200),
            attachmentCount: msg.attachments?.length || 0,
            attachmentTypes: msg.attachments?.map((a) => a.contentType),
          })),
        },
        "[MSTeamsProvider] Raw messages from Graph API",
      );

      // Convert to ChatThreadMessage format and filter out the current message
      const botAppId = config.chatops.msTeams.appId;

      const processedMessages = messages
        .filter((msg) => msg.id !== params.excludeMessageId)
        .map((msg) => {
          // Handle both user messages and application/connector messages (e.g., Grafana IRM)
          const isUserMessage = Boolean(msg.from?.user);
          const senderId = isUserMessage
            ? msg.from?.user?.id || "unknown"
            : msg.from?.application?.id || "unknown";
          const senderName = isUserMessage
            ? msg.from?.user?.displayName || "Unknown"
            : msg.from?.application?.displayName || "App";

          // Extract text from body and/or attachments (Adaptive Cards)
          const text = extractMessageText(msg.body?.content, msg.attachments);

          // Debug: Log extraction results
          logger.debug(
            {
              messageId: msg.id,
              senderName,
              extractedTextLength: text.length,
              extractedTextPreview: text.substring(0, 100),
              hasBody: Boolean(msg.body?.content),
              attachments: msg.attachments?.map((a) => ({
                contentType: a.contentType,
                contentPreview:
                  typeof a.content === "string"
                    ? a.content.substring(0, 100)
                    : "non-string",
              })),
            },
            "[MSTeamsProvider] Message text extraction",
          );

          return {
            messageId: msg.id,
            senderId,
            senderName,
            text,
            timestamp: msg.createdDateTime
              ? new Date(msg.createdDateTime)
              : new Date(),
            // Check if the message is from our bot by comparing app ID
            isFromBot:
              msg.from?.user?.id === botAppId ||
              msg.from?.application?.id === botAppId,
          };
        });

      // Debug: Log filtering results
      const filteredMessages = processedMessages.filter(
        (msg) => msg.text.trim().length > 0,
      );
      logger.debug(
        {
          beforeFilter: processedMessages.length,
          afterFilter: filteredMessages.length,
          filteredOut: processedMessages
            .filter((msg) => msg.text.trim().length === 0)
            .map((msg) => ({ id: msg.messageId, sender: msg.senderName })),
        },
        "[MSTeamsProvider] Messages after filtering empty",
      );

      return (
        filteredMessages
          // Sort by timestamp ascending (oldest first) since API doesn't support orderby
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          channelId: params.channelId,
          workspaceId: params.workspaceId,
        },
        "[MSTeamsProvider] Failed to fetch thread history",
      );
      return [];
    }
  }

  /**
   * Get the Bot Framework adapter for direct use (e.g., for Adaptive Card responses)
   */
  getAdapter(): CloudAdapter | null {
    return this.adapter;
  }

  /**
   * Process an activity through the Bot Framework adapter.
   * This handles JWT validation and returns a TurnContext for responding.
   */
  async processActivity(
    req: {
      body: unknown;
      headers: Record<string, string | string[] | undefined>;
    },
    res: {
      status: (code: number) => { send: (data?: unknown) => void };
      send: (data?: unknown) => void;
    },
    handler: (context: TurnContext) => Promise<void>,
  ): Promise<void> {
    if (!this.adapter) {
      throw new Error("MSTeamsProvider not initialized");
    }

    // Create request/response objects that CloudAdapter.process() expects
    const adapterReq = {
      body: req.body as Record<string, unknown>,
      headers: req.headers,
      method: "POST",
    };

    const adapterRes = {
      socket: null,
      end: () => {},
      header: () => {},
      send: res.send,
      status: res.status,
    };

    await this.adapter.process(adapterReq, adapterRes, handler);
  }
}

/**
 * Cleans bot mentions from message text.
 * Teams includes @mentions in the text as <at>BotName</at>, which we need to remove.
 */
function cleanBotMention(text: string, botName?: string): string {
  // Remove <at>...</at> tags (bot mentions)
  let cleaned = text.replace(/<at>.*?<\/at>/gi, "").trim();

  // Also remove any remaining @BotName patterns if we know the bot name
  if (botName) {
    const mentionPattern = new RegExp(`@${botName}\\s*`, "gi");
    cleaned = cleaned.replace(mentionPattern, "").trim();
  }

  return cleaned;
}

/**
 * Extracts the thread message ID from a Teams activity.
 *
 * Teams conversation IDs can have two formats:
 * 1. Simple: "19:xxx@thread.tacv2" (no thread, just channel)
 * 2. Thread: "19:xxx@thread.tacv2;messageid=1234567890" (reply in a thread)
 *
 * For thread replies, we need to extract just the message ID (e.g., "1234567890")
 * to use with the Graph API /messages/{messageId}/replies endpoint.
 */
function extractThreadId(activity: {
  conversation?: { id?: string };
  replyToId?: string;
}): string | undefined {
  // If replyToId is set, use it (this is the most reliable indicator)
  if (activity.replyToId) {
    return activity.replyToId;
  }

  // Check if conversation ID contains ";messageid=" which indicates a thread reply
  const conversationId = activity.conversation?.id;
  if (conversationId?.includes(";messageid=")) {
    // Extract the message ID from the format "channelId;messageid=messageId"
    const match = conversationId.match(/;messageid=(\d+)/);
    if (match) {
      return match[1]; // Return just the message ID
    }
  }

  // No thread - return undefined (not the channel ID)
  return undefined;
}

/**
 * Extracts text content from message body and/or attachments (Adaptive Cards).
 * Grafana IRM and similar connectors send content as Adaptive Card attachments.
 */
function extractMessageText(
  bodyContent?: string,
  attachments?: { contentType?: string; content?: string; name?: string }[],
): string {
  const parts: string[] = [];

  // Add body content if present (strip HTML tags)
  if (bodyContent) {
    const cleanedBody = stripHtmlTags(bodyContent).trim();
    if (cleanedBody) {
      parts.push(cleanedBody);
    }
  }

  // Extract text from Adaptive Card attachments
  if (attachments && attachments.length > 0) {
    for (const attachment of attachments) {
      if (
        attachment.contentType === "application/vnd.microsoft.card.adaptive" &&
        attachment.content
      ) {
        try {
          // Parse the Adaptive Card JSON and extract text elements
          const card =
            typeof attachment.content === "string"
              ? JSON.parse(attachment.content)
              : attachment.content;
          const cardText = extractAdaptiveCardText(card);
          if (cardText) {
            parts.push(cardText);
          }
        } catch {
          // If JSON parsing fails, try to use content as-is
          if (typeof attachment.content === "string") {
            parts.push(attachment.content);
          }
        }
      }
    }
  }

  return parts.join("\n\n");
}

/**
 * Recursively extracts text from Adaptive Card elements.
 */
function extractAdaptiveCardText(element: unknown): string {
  if (!element || typeof element !== "object") {
    return "";
  }

  const parts: string[] = [];
  const el = element as Record<string, unknown>;

  // Extract text from TextBlock elements
  if (el.type === "TextBlock" && typeof el.text === "string") {
    parts.push(el.text);
  }

  // Extract text from FactSet elements (key-value pairs like in Grafana alerts)
  if (el.type === "FactSet" && Array.isArray(el.facts)) {
    for (const fact of el.facts as { title?: string; value?: string }[]) {
      if (fact.title && fact.value) {
        parts.push(`${fact.title}: ${fact.value}`);
      }
    }
  }

  // Recursively process body array
  if (Array.isArray(el.body)) {
    for (const item of el.body) {
      const text = extractAdaptiveCardText(item);
      if (text) parts.push(text);
    }
  }

  // Recursively process items array (for containers)
  if (Array.isArray(el.items)) {
    for (const item of el.items) {
      const text = extractAdaptiveCardText(item);
      if (text) parts.push(text);
    }
  }

  // Recursively process columns
  if (Array.isArray(el.columns)) {
    for (const col of el.columns) {
      const text = extractAdaptiveCardText(col);
      if (text) parts.push(text);
    }
  }

  return parts.join("\n");
}

/**
 * Strips HTML tags from text content.
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export default MSTeamsProvider;
