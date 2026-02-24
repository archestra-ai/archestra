import { createHmac, timingSafeEqual } from "node:crypto";
import { TimeInMs } from "@shared";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import {
  AgentModel,
  ChatOpsChannelBindingModel,
  type SlackConfig,
  UserModel,
} from "@/models";
import type {
  ChatOpsEventHandler,
  ChatOpsProvider,
  ChatOpsProviderType,
  ChatReplyOptions,
  ChatThreadMessage,
  DiscoveredChannel,
  IncomingChatMessage,
  ThreadHistoryParams,
} from "@/types/chatops";
import {
  CHATOPS_THREAD_HISTORY,
  SLACK_DEFAULT_CONNECTION_MODE,
  SLACK_SLASH_COMMANDS,
} from "./constants";
import { EventDedupMap, errorMessage } from "./utils";

/**
 * Slack provider using Slack Web API.
 *
 * Security:
 * - Request verification via HMAC SHA256 signing secret
 * - Replay attack protection via timestamp check (5 minute window)
 */
class SlackProvider implements ChatOpsProvider {
  readonly providerId: ChatOpsProviderType = "slack";
  readonly displayName = "Slack";

  private client: WebClient | null = null;
  private botUserId: string | null = null;
  private teamId: string | null = null;
  private teamName: string | null = null;
  private config: SlackConfig;
  private socketModeClient: SocketModeClient | null = null;
  private eventHandler: ChatOpsEventHandler | null = null;
  private socketDedup = new EventDedupMap();

  constructor(slackConfig: SlackConfig) {
    this.config = slackConfig;
  }

  isConfigured(): boolean {
    if (!this.config.enabled || !this.config.botToken) return false;
    if (this.isSocketMode()) {
      return Boolean(this.config.appLevelToken);
    }
    return Boolean(this.config.signingSecret);
  }

  isSocketMode(): boolean {
    return this.config.connectionMode === "socket";
  }

  getConnectionMode(): "webhook" | "socket" {
    return this.config.connectionMode === "webhook"
      ? "webhook"
      : SLACK_DEFAULT_CONNECTION_MODE;
  }

  setEventHandler(handler: ChatOpsEventHandler): void {
    this.eventHandler = handler;
  }

  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info("[SlackProvider] Not configured, skipping initialization");
      return;
    }

    const { botToken } = this.config;
    this.client = new WebClient(botToken);

    try {
      const authResult = await this.client.auth.test();
      this.botUserId = (authResult.user_id as string) || null;
      this.teamId = (authResult.team_id as string) || null;
      this.teamName = (authResult.team as string) || null;
      logger.info(
        { botUserId: this.botUserId, teamId: this.teamId },
        "[SlackProvider] Authenticated successfully",
      );
    } catch (error) {
      logger.error(
        { error: errorMessage(error) },
        "[SlackProvider] Failed to authenticate with Slack",
      );
      throw error;
    }

    if (this.isSocketMode()) {
      await this.startSocketMode();
    }
  }

  getWorkspaceId(): string | null {
    return this.teamId;
  }

  getWorkspaceName(): string | null {
    return this.teamName;
  }

  async cleanup(): Promise<void> {
    if (this.socketModeClient) {
      try {
        await this.socketModeClient.disconnect();
      } catch (error) {
        logger.warn(
          { error: errorMessage(error) },
          "[SlackProvider] Error disconnecting socket mode client",
        );
      }
      this.socketModeClient = null;
    }
    this.eventHandler = null;
    this.socketDedup.clear();
    this.client = null;
    this.botUserId = null;
    this.teamId = null;
    this.teamName = null;
    logger.info("[SlackProvider] Cleaned up");
  }

  async validateWebhookRequest(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    const timestamp = getHeader(headers, "x-slack-request-timestamp");
    const signature = getHeader(headers, "x-slack-signature");

    if (!timestamp || !signature) {
      logger.warn("[SlackProvider] Missing signature headers");
      return false;
    }

    // Replay attack protection: reject requests older than 5 minutes
    const requestTime = Number.parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - requestTime) > 300) {
      logger.warn(
        { requestTime, now },
        "[SlackProvider] Request timestamp too old (replay attack?)",
      );
      return false;
    }

    // Compute expected signature
    // rawBody must be the exact bytes captured by the preParsing hook
    const sigBaseString = `v0:${timestamp}:${rawBody}`;
    const expectedSignature = `v0=${createHmac("sha256", this.config.signingSecret).update(sigBaseString).digest("hex")}`;

    // Timing-safe comparison
    try {
      const sigBuffer = Buffer.from(signature, "utf8");
      const expectedBuffer = Buffer.from(expectedSignature, "utf8");
      if (sigBuffer.length !== expectedBuffer.length) {
        logger.warn("[SlackProvider] Signature length mismatch");
        return false;
      }
      return timingSafeEqual(sigBuffer, expectedBuffer);
    } catch {
      logger.warn("[SlackProvider] Signature comparison failed");
      return false;
    }
  }

  handleValidationChallenge(payload: unknown): unknown | null {
    const body = payload as { type?: string; challenge?: string };
    if (body?.type === "url_verification" && body.challenge) {
      return { challenge: body.challenge };
    }
    return null;
  }

  async parseWebhookNotification(
    payload: unknown,
    _headers: Record<string, string | string[] | undefined>,
  ): Promise<IncomingChatMessage | null> {
    const body = payload as SlackEventPayload;

    // Only process event_callback
    if (body.type !== "event_callback" || !body.event) {
      return null;
    }

    const event = body.event;

    // Only process message and app_mention events.
    // assistant_thread_started and assistant_thread_context_changed events are
    // subscribed in the manifest (required for "Agents & AI Apps" designation)
    // but intentionally dropped here — handling them (e.g., welcome messages,
    // suggested prompts) is deferred to a future phase.
    if (event.type !== "message" && event.type !== "app_mention") {
      return null;
    }

    // Skip bot messages to avoid loops
    if (event.bot_id || event.subtype === "bot_message") {
      return null;
    }

    // Skip messages from the bot itself
    if (this.botUserId && event.user === this.botUserId) {
      return null;
    }

    const text = event.text || "";
    const isThreadReply = Boolean(event.thread_ts);
    const isDM = event.channel_type === "im";

    // In channels (including thread replies), only respond when the bot is
    // @mentioned (app_mention event or message text containing <@BOT_ID>).
    // DMs are always processed without requiring a mention.
    if (!isDM) {
      const hasBotMention =
        this.botUserId && text.includes(`<@${this.botUserId}>`);
      if (event.type !== "app_mention" && !hasBotMention) {
        return null;
      }
    }

    const cleanedText = this.cleanBotMention(text);

    if (!cleanedText.trim()) {
      return null;
    }

    const threadTs = event.thread_ts || event.ts;

    return {
      messageId: event.ts,
      channelId: event.channel,
      workspaceId: body.team_id || null,
      threadId: threadTs,
      senderId: event.user || "unknown",
      senderName: event.user || "Unknown User",
      text: cleanedText,
      rawText: text,
      timestamp: new Date(Number.parseFloat(event.ts) * 1000),
      isThreadReply,
      metadata: {
        eventType: event.type,
        channelType: event.channel_type,
      },
    };
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    if (!this.client) {
      throw new Error("SlackProvider not initialized");
    }

    // biome-ignore lint/suspicious/noExplicitAny: Block Kit types are complex; shape is correct
    const blocks: any[] = [
      { type: "section", text: { type: "mrkdwn", text: options.text } },
    ];

    if (options.footer) {
      blocks.push(
        { type: "divider" },
        {
          type: "context",
          elements: [{ type: "plain_text", text: options.footer, emoji: true }],
        },
      );
    }

    const result = await this.client.chat.postMessage({
      channel: options.originalMessage.channelId,
      text: options.text,
      blocks,
      thread_ts: options.originalMessage.threadId,
    });

    return (result.ts as string) || "";
  }

  async sendAgentSelectionCard(params: {
    message: IncomingChatMessage;
    agents: { id: string; name: string }[];
    isWelcome: boolean;
  }): Promise<void> {
    if (!this.client) {
      throw new Error("SlackProvider not initialized");
    }

    const agentButtons = params.agents.map((agent) => ({
      type: "button" as const,
      text: {
        type: "plain_text" as const,
        text: agent.name,
      },
      action_id: `select_agent_${agent.id}`,
      value: agent.id,
    }));

    // Slack allows max 5 elements per actions block, split if needed
    const actionBlocks: Record<string, unknown>[] = [];
    for (let i = 0; i < agentButtons.length; i += 5) {
      actionBlocks.push({
        type: "actions" as const,
        elements: agentButtons.slice(i, i + 5),
      });
    }

    const blocks: Record<string, unknown>[] = params.isWelcome
      ? [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Welcome to Archestra!*\nEach Slack channel needs a *default agent* bound to it. This agent will handle all your requests in this channel by default.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Tip:* You can use other agents with the syntax *AgentName >* (e.g., @Archestra Sales > what's the status?).",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Available commands:*\n`/archestra-select-agent` — Change the default agent handling requests in the channel\n`/archestra-status` — Check the current agent handling requests in the channel\n`/archestra-help` — Show available commands",
            },
          },
          { type: "divider" },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Let's set the default agent for this channel:*",
            },
          },
          ...actionBlocks,
        ]
      : [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Change Default Agent*\nSelect a different agent to handle messages in this channel:",
            },
          },
          ...actionBlocks,
        ];

    await this.client.chat.postMessage({
      channel: params.message.channelId,
      thread_ts: params.message.threadId,
      text: params.isWelcome ? "Welcome to Archestra!" : "Change Default Agent",
      // biome-ignore lint/suspicious/noExplicitAny: Block Kit types are complex; shape is correct
      blocks: blocks as any,
    });
  }

  async getThreadHistory(
    params: ThreadHistoryParams,
  ): Promise<ChatThreadMessage[]> {
    if (!this.client) {
      logger.warn("[SlackProvider] Client not initialized, skipping history");
      return [];
    }

    const limit = Math.min(
      params.limit || CHATOPS_THREAD_HISTORY.DEFAULT_LIMIT,
      CHATOPS_THREAD_HISTORY.MAX_LIMIT,
    );

    try {
      const result = await this.client.conversations.replies({
        channel: params.channelId,
        ts: params.threadId,
        limit,
      });

      const messages = result.messages || [];
      return messages
        .filter(
          (msg) => msg.ts && msg.ts !== params.excludeMessageId && msg.text,
        )
        .map((msg) => ({
          messageId: msg.ts as string,
          senderId: msg.user || msg.bot_id || "unknown",
          senderName: msg.user || "Unknown",
          text: msg.text || "",
          timestamp: new Date(Number.parseFloat(msg.ts as string) * 1000),
          isFromBot: Boolean(msg.bot_id) || msg.user === this.botUserId,
        }))
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), channelId: params.channelId },
        "[SlackProvider] Failed to fetch thread history",
      );
      return [];
    }
  }

  async getUserEmail(userId: string): Promise<string | null> {
    if (!this.client) {
      logger.warn("[SlackProvider] Client not initialized, cannot get email");
      return null;
    }

    // Check distributed cache first (avoids Slack API call per message)
    const cacheKey = `${CacheKey.SlackUserEmail}-${userId}` as AllowedCacheKey;
    const cached = await cacheManager.get<string>(cacheKey);
    if (cached) return cached;

    try {
      const result = await this.client.users.info({ user: userId });
      const email = result.user?.profile?.email || null;
      if (email) {
        // Cache for 5 minutes — email rarely changes
        await cacheManager
          .set(cacheKey, email, TimeInMs.Minute * 5)
          .catch(() => {});
      }
      return email;
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), userId },
        "[SlackProvider] Failed to get user email",
      );
      return null;
    }
  }

  async getChannelName(channelId: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const result = await this.client.conversations.info({
        channel: channelId,
      });
      return (result.channel as { name?: string })?.name || null;
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), channelId },
        "[SlackProvider] Failed to get channel name",
      );
      return null;
    }
  }

  async discoverChannels(_context: unknown): Promise<DiscoveredChannel[]> {
    if (!this.client) {
      return [];
    }

    try {
      const result = await this.client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 999,
      });

      const channels = result.channels || [];
      // Only include channels where the bot is a member
      return channels
        .filter((ch) => ch.id && ch.is_member)
        .map((ch) => ({
          channelId: ch.id as string,
          channelName: ch.name || null,
          workspaceId: ch.shared_team_ids?.[0] || this.teamId || "default",
          workspaceName: this.teamName,
        }));
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[SlackProvider] Failed to discover channels",
      );
      return [];
    }
  }

  /**
   * Parse a block_actions interactive payload (agent selection button click).
   * Returns the selected agent ID and context, or null if not a valid selection.
   */
  parseInteractivePayload(payload: unknown): {
    agentId: string;
    channelId: string;
    workspaceId: string | null;
    threadTs?: string;
    userId: string;
    userName: string;
    responseUrl: string;
  } | null {
    const p = payload as SlackInteractivePayload;
    if (p.type !== "block_actions" || !p.actions?.length) {
      return null;
    }

    const action = p.actions[0];
    if (!action.action_id?.startsWith("select_agent_") || !action.value) {
      return null;
    }

    return {
      agentId: action.value,
      channelId: p.channel?.id || "",
      workspaceId: p.team?.id || null,
      threadTs: p.message?.thread_ts || p.message?.ts,
      userId: p.user?.id || "unknown",
      userName: p.user?.name || "Unknown",
      responseUrl: p.response_url || "",
    };
  }

  /**
   * Handle a Slack slash command.
   * Returns the response object. Caller is responsible for delivery
   * (HTTP response for webhooks, response_url POST for socket mode).
   */
  async handleSlashCommand(body: {
    command?: string;
    text?: string;
    user_id?: string;
    user_name?: string;
    channel_id?: string;
    channel_name?: string;
    team_id?: string;
    response_url?: string;
    trigger_id?: string;
  }): Promise<{ response_type: string; text: string } | null> {
    const command = body.command;
    const channelId = body.channel_id || "";
    const workspaceId = body.team_id || null;
    const userId = body.user_id || "unknown";

    // Resolve sender email and verify user
    const senderEmail = await this.getUserEmail(userId);
    if (!senderEmail) {
      return {
        response_type: "ephemeral",
        text: "Could not verify your identity. Please ensure your Slack profile has an email configured.",
      };
    }

    const user = await UserModel.findByEmail(senderEmail.toLowerCase());
    if (!user) {
      return {
        response_type: "ephemeral",
        text: `You (${senderEmail}) are not a registered Archestra user. Contact your administrator for access.`,
      };
    }

    switch (command) {
      case SLACK_SLASH_COMMANDS.HELP:
        return {
          response_type: "ephemeral",
          text:
            "*Available commands:*\n" +
            "`/archestra-select-agent` — Change the default agent\n" +
            "`/archestra-status` — Show current agent binding\n" +
            "`/archestra-help` — Show this help message\n\n" +
            "Or just send a message to interact with the bound agent.",
        };

      case SLACK_SLASH_COMMANDS.STATUS: {
        const binding = await ChatOpsChannelBindingModel.findByChannel({
          provider: "slack",
          channelId,
          workspaceId,
        });

        if (binding?.agentId) {
          const agent = await AgentModel.findById(binding.agentId);
          return {
            response_type: "ephemeral",
            text:
              `This channel is bound to agent: *${agent?.name || binding.agentId}*\n\n` +
              "*Tip:* You can use other agents with the syntax *AgentName >* (e.g., @Archestra Sales > what's the status?).\n\n" +
              "Use `/archestra-select-agent` to change the default agent.",
          };
        }

        return {
          response_type: "ephemeral",
          text: "No agent is bound to this channel yet.\nSend any message to set up an agent binding.",
        };
      }

      case SLACK_SLASH_COMMANDS.SELECT_AGENT: {
        // Send agent selection card (visible to all in channel)
        const message: IncomingChatMessage = {
          messageId: `slack-slash-${Date.now()}`,
          channelId,
          workspaceId,
          threadId: undefined,
          senderId: userId,
          senderName: body.user_name || "Unknown User",
          senderEmail,
          text: body.text || "",
          rawText: body.text || "",
          timestamp: new Date(),
          isThreadReply: false,
        };

        const agents =
          (await this.eventHandler?.getAccessibleChatopsAgents({
            senderEmail,
          })) ?? [];

        if (agents.length === 0) {
          await this.sendReply({
            originalMessage: message,
            text: "No agents are available for you in Slack.\nContact your administrator to get access to an agent with Slack enabled.",
          });
        } else {
          await this.sendAgentSelectionCard({
            message,
            agents,
            isWelcome: false,
          });
        }
        return { response_type: "in_channel", text: "" };
      }

      default:
        return {
          response_type: "ephemeral",
          text: "Unknown command. Use `/archestra-help` to see available commands.",
        };
    }
  }

  async setTypingStatus(channelId: string, threadTs: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status: "is thinking...",
      });
    } catch (error) {
      // Non-fatal: fails if "Agents & AI Apps" isn't enabled or scope missing
      logger.debug(
        { error: errorMessage(error) },
        "[SlackProvider] setTypingStatus failed (non-fatal)",
      );
    }
  }

  getBotUserId(): string | null {
    return this.botUserId;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Handle a slash command received via socket mode.
   * Uses ack() to send the response directly (supported by the SocketModeClient).
   */
  private async handleSlashCommandSocket(
    body: unknown,
    ack: (response?: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    try {
      const cmd = body as {
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
      const response = await this.handleSlashCommand(cmd);
      // Acknowledge with the response body — SocketModeClient sends it back via the socket
      await ack(response ? (response as Record<string, unknown>) : undefined);
    } catch (error) {
      logger.error(
        { error: errorMessage(error) },
        "[SlackProvider] Slash command failed",
      );
      await ack({
        response_type: "ephemeral",
        text: "Something went wrong. Please try again.",
      });
    }
  }

  private async startSocketMode(): Promise<void> {
    const appToken = this.config.appLevelToken;
    if (!appToken) {
      logger.error(
        "[SlackProvider] Cannot start socket mode: appLevelToken is missing",
      );
      return;
    }

    this.socketModeClient = new SocketModeClient({
      appToken,
      autoReconnectEnabled: true,
    });

    // The SocketModeClient dispatches events as follows (see source):
    //   events_api  → emits inner event type ("message", "app_mention"), body = full envelope
    //   interactive → emits "interactive", body = interaction payload
    //   slash_commands → emits "slash_commands", body = command payload
    //   ALL types   → also emits "slack_event" with { type, body }
    //
    // We use "slack_event" as a single catch-all to route all event types.
    this.socketModeClient.on(
      "slack_event",
      async ({
        ack,
        type,
        body,
      }: {
        ack: (response?: Record<string, unknown>) => Promise<void>;
        type: string;
        body: unknown;
        retry_num?: number;
      }) => {
        switch (type) {
          case "events_api": {
            await ack();
            const eventBody = body as { event?: { ts?: string } };
            const eventTs = eventBody?.event?.ts;
            if (eventTs && this.socketDedup.mark(eventTs)) {
              break;
            }
            this.eventHandler
              ?.handleIncomingMessage(this, body)
              .catch((error) => {
                logger.error(
                  { error: errorMessage(error) },
                  "[SlackProvider] Error processing socket event",
                );
              });
            break;
          }
          case "interactive":
            await ack();
            this.eventHandler
              ?.handleInteractiveSelection(this, body)
              .catch((error) => {
                logger.error(
                  { error: errorMessage(error) },
                  "[SlackProvider] Error processing socket interactive event",
                );
              });
            break;
          case "slash_commands":
            // ack() for slash commands can include a response body
            this.handleSlashCommandSocket(body, ack).catch((error) => {
              logger.error(
                { error: errorMessage(error) },
                "[SlackProvider] Error processing socket slash command",
              );
            });
            break;
          default:
            await ack();
            break;
        }
      },
    );

    try {
      await this.socketModeClient.start();
      logger.info("[SlackProvider] Socket mode connected");
    } catch (error) {
      logger.error(
        { error: errorMessage(error) },
        "[SlackProvider] Failed to start socket mode",
      );
      throw error;
    }
  }

  private cleanBotMention(text: string): string {
    if (!this.botUserId) return text;
    // Slack mentions are formatted as <@U12345678>
    let cleaned = text
      .replace(new RegExp(`<@${this.botUserId}>`, "g"), "")
      .trim();
    // Slack HTML-encodes &, <, > outside of special sequences (<@U...>, <#C...>, <url>).
    // Decode so downstream logic (e.g., inline agent "AgentName > msg") sees literal chars.
    cleaned = decodeSlackEntities(cleaned);
    return cleaned;
  }
}

export default SlackProvider;

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Decode Slack's HTML entity encoding.
 * Slack encodes &, <, > as &amp;, &lt;, &gt; in event text outside of special
 * sequences like <@U123>, <#C123>, and <url>.
 */
function decodeSlackEntities(text: string): string {
  return text
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/**
 * Get a header value as a string, handling both string and string[] values.
 */
function getHeader(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = headers[key] || headers[key.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

// =============================================================================
// Slack Event Types
// =============================================================================

interface SlackEventPayload {
  type: string;
  team_id?: string;
  event?: {
    type: string;
    channel: string;
    channel_type?: string;
    user?: string;
    bot_id?: string;
    subtype?: string;
    text?: string;
    ts: string;
    thread_ts?: string;
  };
  challenge?: string;
}

interface SlackInteractivePayload {
  type: string;
  actions?: Array<{
    action_id: string;
    value: string;
  }>;
  user?: { id: string; name: string };
  channel?: { id: string };
  team?: { id: string };
  message?: { ts: string; thread_ts?: string };
  response_url?: string;
}
