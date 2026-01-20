import { ClientSecretCredential } from "@azure/identity";
import { AzureIdentityAuthenticationProvider } from "@microsoft/kiota-authentication-azure";
import {
  createGraphServiceClient,
  GraphRequestAdapter,
  type GraphServiceClient,
} from "@microsoft/msgraph-sdk";
import type {
  ChatMessage,
  ChatMessageAttachment,
} from "@microsoft/msgraph-sdk/models";
// Register the chats and teams fluent API extensions
import "@microsoft/msgraph-sdk-chats";
import "@microsoft/msgraph-sdk-teams";
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
 * MS Teams provider using Bot Framework SDK.
 *
 * Security:
 * - JWT validation handled automatically by CloudAdapter
 * - Supports single-tenant and multi-tenant Azure Bot configurations
 */
class MSTeamsProvider implements ChatOpsProvider {
  readonly providerId: ChatOpsProviderType = "ms-teams";
  readonly displayName = "Microsoft Teams";

  private adapter: CloudAdapter | null = null;
  private graphClient: GraphServiceClient | null = null;

  isConfigured(): boolean {
    const { enabled, appId, appSecret } = config.chatops.msTeams;
    return enabled && Boolean(appId) && Boolean(appSecret);
  }

  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info("[MSTeamsProvider] Not configured, skipping initialization");
      return;
    }

    const { appId, appSecret, tenantId, graph } = config.chatops.msTeams;

    // Initialize Bot Framework adapter
    const credentialsFactory = tenantId
      ? new PasswordServiceClientCredentialFactory(appId, appSecret, tenantId)
      : new PasswordServiceClientCredentialFactory(appId, appSecret);

    const auth = new ConfigurationBotFrameworkAuthentication(
      { MicrosoftAppId: appId, MicrosoftAppTenantId: tenantId || undefined },
      credentialsFactory,
    );

    this.adapter = new CloudAdapter(auth);
    this.adapter.onTurnError = async (_context, error) => {
      logger.error(
        { error: errorMessage(error) },
        "[MSTeamsProvider] Bot Framework error",
      );
    };

    logger.info(
      { tenantMode: tenantId ? "single-tenant" : "multi-tenant" },
      "[MSTeamsProvider] Bot Framework adapter initialized",
    );

    // Initialize Graph client if configured
    if (graph?.tenantId && graph?.clientId && graph?.clientSecret) {
      const credential = new ClientSecretCredential(
        graph.tenantId,
        graph.clientId,
        graph.clientSecret,
      );
      const authProvider = new AzureIdentityAuthenticationProvider(credential, [
        "https://graph.microsoft.com/.default",
      ]);
      const requestAdapter = new GraphRequestAdapter(authProvider);
      this.graphClient = createGraphServiceClient(requestAdapter);
      logger.info("[MSTeamsProvider] Graph client initialized");
    } else {
      logger.info(
        "[MSTeamsProvider] Graph API not configured, thread history unavailable",
      );
    }
  }

  async cleanup(): Promise<void> {
    this.adapter = null;
    this.graphClient = null;
    logger.info("[MSTeamsProvider] Cleaned up");
  }

  async validateWebhookRequest(
    _payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    const authHeader = headers.authorization || headers.Authorization;
    if (!authHeader) {
      logger.warn("[MSTeamsProvider] Missing Authorization header");
      return false;
    }
    return true;
  }

  handleValidationChallenge(_payload: unknown): unknown | null {
    return null;
  }

  async parseWebhookNotification(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<IncomingChatMessage | null> {
    if (!this.adapter) {
      logger.error("[MSTeamsProvider] Adapter not initialized");
      return null;
    }

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

    if (activity.type !== ActivityTypes.Message || !activity.text) {
      return null;
    }

    // Extract channel ID, stripping thread suffix if present
    let channelId =
      activity.channelData?.channel?.id || activity.conversation?.id;
    if (channelId?.includes(";messageid=")) {
      channelId = channelId.split(";messageid=")[0];
    }

    if (!channelId) {
      logger.warn(
        "[MSTeamsProvider] Cannot determine channel ID from activity",
      );
      return null;
    }

    const cleanedText = cleanBotMention(
      activity.text,
      activity.recipient?.name,
    );
    if (!cleanedText) {
      return null;
    }

    const conversationId = activity.conversation?.id;
    const isThreadReply =
      Boolean(activity.replyToId) ||
      Boolean(conversationId?.includes(";messageid="));

    return {
      messageId: activity.id || `teams-${Date.now()}`,
      channelId,
      workspaceId: activity.channelData?.team?.id || null,
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
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    if (!this.adapter) {
      throw new Error("MSTeamsProvider not initialized");
    }

    const ref =
      (options.conversationReference as ConversationReference | undefined) ||
      (options.originalMessage.metadata?.conversationReference as
        | ConversationReference
        | undefined);

    if (!ref) {
      throw new Error("No conversation reference available for reply");
    }

    let replyText = options.text;
    if (options.footer) {
      replyText += `\n\n---\n_${options.footer}_`;
    }

    let messageId = "";
    await this.adapter.continueConversationAsync(
      config.chatops.msTeams.appId,
      ref,
      async (context) => {
        const response = await context.sendActivity(replyText);
        messageId = response?.id || "";
      },
    );

    return messageId;
  }

  async getThreadHistory(
    params: ThreadHistoryParams,
  ): Promise<ChatThreadMessage[]> {
    if (!this.graphClient) {
      return [];
    }

    const limit = Math.min(
      params.limit || CHATOPS_THREAD_HISTORY.DEFAULT_LIMIT,
      CHATOPS_THREAD_HISTORY.MAX_LIMIT,
    );

    try {
      const isGroupChat =
        !params.workspaceId ||
        params.workspaceId.startsWith("19:") ||
        params.channelId.includes("@thread");

      const messages = isGroupChat
        ? await this.fetchGroupChatHistory(params, limit)
        : await this.fetchTeamChannelHistory(params, limit);

      return this.convertToThreadMessages(messages, params.excludeMessageId);
    } catch (error) {
      logger.error(
        { error: errorMessage(error), channelId: params.channelId },
        "[MSTeamsProvider] Failed to fetch thread history",
      );
      return [];
    }
  }

  getAdapter(): CloudAdapter | null {
    return this.adapter;
  }

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

    await this.adapter.process(
      {
        body: req.body as Record<string, unknown>,
        headers: req.headers,
        method: "POST",
      },
      {
        socket: null,
        end: () => {},
        header: () => {},
        send: res.send,
        status: res.status,
      },
      handler,
    );
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async fetchGroupChatHistory(
    params: ThreadHistoryParams,
    limit: number,
  ): Promise<ChatMessage[]> {
    const client = this.graphClient;
    if (!client) return [];

    const chatMessages = client.chats.byChatId(params.channelId).messages;

    // For thread replies, fetch parent message and attempt to get replies
    if (params.threadId && !params.threadId.includes("@thread")) {
      const parentMessage = await chatMessages
        .byChatMessageId(params.threadId)
        .get();

      try {
        const repliesResponse = await chatMessages
          .byChatMessageId(params.threadId)
          .replies.get({ queryParameters: { top: limit - 1 } });
        return [parentMessage, ...(repliesResponse?.value || [])].filter(
          (msg): msg is ChatMessage => msg !== undefined,
        );
      } catch (error) {
        // /replies endpoint not supported for group chats - use parent message only
        logger.warn(
          { error: errorMessage(error), threadId: params.threadId },
          "[MSTeamsProvider] Thread replies unavailable for group chat (API limitation)",
        );
        return parentMessage ? [parentMessage] : [];
      }
    }

    // No thread - fetch recent messages
    const response = await chatMessages.get({
      queryParameters: { top: limit },
    });
    return response?.value || [];
  }

  private async fetchTeamChannelHistory(
    params: ThreadHistoryParams,
    limit: number,
  ): Promise<ChatMessage[]> {
    const client = this.graphClient;
    if (!client || !params.workspaceId) return [];

    const channelMessages = client.teams
      .byTeamId(params.workspaceId)
      .channels.byChannelId(params.channelId).messages;

    const isThreadReply =
      params.threadId &&
      params.threadId !== params.channelId &&
      !params.threadId.includes("@thread");

    if (isThreadReply) {
      const messageBuilder = channelMessages.byChatMessageId(params.threadId);
      try {
        const [parentResponse, repliesResponse] = await Promise.all([
          messageBuilder.get(),
          messageBuilder.replies.get({ queryParameters: { top: limit - 1 } }),
        ]);
        return [parentResponse, ...(repliesResponse?.value || [])].filter(
          (msg): msg is ChatMessage => msg !== undefined,
        );
      } catch (error) {
        logger.warn(
          { error: errorMessage(error), threadId: params.threadId },
          "[MSTeamsProvider] Failed to fetch thread, falling back to replies only",
        );
        const response = await messageBuilder.replies.get({
          queryParameters: { top: limit },
        });
        return response?.value || [];
      }
    }

    const response = await channelMessages.get({
      queryParameters: { top: limit },
    });
    return response?.value || [];
  }

  private convertToThreadMessages(
    messages: ChatMessage[],
    excludeMessageId?: string,
  ): ChatThreadMessage[] {
    const botAppId = config.chatops.msTeams.appId;

    return messages
      .filter((msg) => msg.id && msg.id !== excludeMessageId)
      .map((msg) => {
        const isUserMessage = Boolean(msg.from?.user);
        return {
          messageId: msg.id as string,
          senderId: isUserMessage
            ? msg.from?.user?.id || "unknown"
            : msg.from?.application?.id || "unknown",
          senderName: isUserMessage
            ? msg.from?.user?.displayName || "Unknown"
            : msg.from?.application?.displayName || "App",
          text: extractMessageText(
            msg.body?.content ?? undefined,
            msg.attachments ?? undefined,
          ),
          timestamp: msg.createdDateTime
            ? new Date(msg.createdDateTime)
            : new Date(),
          isFromBot:
            msg.from?.user?.id === botAppId ||
            msg.from?.application?.id === botAppId,
        };
      })
      .filter((msg) => msg.text.trim().length > 0)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
}

export default MSTeamsProvider;

// =============================================================================
// Internal Helpers
// =============================================================================

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanBotMention(text: string, botName?: string): string {
  let cleaned = text.replace(/<at>.*?<\/at>/gi, "").trim();
  if (botName) {
    const escapedName = escapeRegExp(botName);
    cleaned = cleaned
      .replace(new RegExp(`@${escapedName}\\s*`, "gi"), "")
      .trim();
  }
  return cleaned;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract thread message ID from Teams activity.
 * Teams format: "channelId;messageid=messageId" for thread replies.
 */
function extractThreadId(activity: {
  conversation?: { id?: string };
  replyToId?: string;
}): string | undefined {
  if (activity.replyToId) {
    return activity.replyToId;
  }

  const conversationId = activity.conversation?.id;
  if (conversationId?.includes(";messageid=")) {
    const match = conversationId.match(/;messageid=(\d+)/);
    return match?.[1];
  }

  return undefined;
}

/**
 * Extract text from message body and/or Adaptive Card attachments.
 */
function extractMessageText(
  bodyContent?: string,
  attachments?: ChatMessageAttachment[],
): string {
  const parts: string[] = [];

  if (bodyContent) {
    const cleanedBody = stripHtmlTags(bodyContent).trim();
    if (cleanedBody) parts.push(cleanedBody);
  }

  if (attachments?.length) {
    for (const attachment of attachments) {
      if (
        attachment.contentType === "application/vnd.microsoft.card.adaptive" &&
        attachment.content
      ) {
        try {
          const card =
            typeof attachment.content === "string"
              ? JSON.parse(attachment.content)
              : attachment.content;
          const cardText = extractAdaptiveCardText(card);
          if (cardText) parts.push(cardText);
        } catch {
          if (typeof attachment.content === "string") {
            parts.push(attachment.content);
          }
        }
      }
    }
  }

  return parts.join("\n\n");
}

function extractAdaptiveCardText(element: unknown): string {
  if (!element || typeof element !== "object") return "";

  const parts: string[] = [];
  const el = element as Record<string, unknown>;

  if (el.type === "TextBlock" && typeof el.text === "string") {
    parts.push(el.text);
  }

  if (el.type === "FactSet" && Array.isArray(el.facts)) {
    for (const fact of el.facts as { title?: string; value?: string }[]) {
      if (fact.title && fact.value) {
        parts.push(`${fact.title}: ${fact.value}`);
      }
    }
  }

  for (const key of ["body", "items", "columns"] as const) {
    if (Array.isArray(el[key])) {
      for (const item of el[key] as unknown[]) {
        const text = extractAdaptiveCardText(item);
        if (text) parts.push(text);
      }
    }
  }

  return parts.join("\n");
}

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
