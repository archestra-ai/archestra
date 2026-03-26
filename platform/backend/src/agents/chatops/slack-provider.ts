import { createHmac, timingSafeEqual } from "node:crypto";
import { SLACK_REQUIRED_BOT_SCOPES, TimeInMs } from "@shared";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { slackifyMarkdown } from "slackify-markdown";
import {
  type AllowedCacheKey,
  CacheKey,
  cacheManager,
  LRUCacheManager,
} from "@/cache-manager";
import logger from "@/logging";
import { AgentModel, ChatOpsChannelBindingModel, UserModel } from "@/models";
import type {
  ChatOpsConnectionMode,
  ChatOpsEventHandler,
  ChatOpsProvider,
  ChatOpsProviderType,
  ChatReplyOptions,
  ChatThreadMessage,
  ChatThreadMessageFile,
  DiscoveredChannel,
  IncomingChatMessage,
  SlackDbConfig,
  ThreadHistoryParams,
} from "@/types";
import {
  autoProvisionUser,
  buildWelcomeMessage,
  isSsoConfigured,
} from "./auto-provision";
import {
  CHATOPS_ATTACHMENT_LIMITS,
  CHATOPS_THREAD_HISTORY,
  SLACK_DEFAULT_CONNECTION_MODE,
  SLACK_SLASH_COMMANDS,
} from "./constants";
import { EventDedupMap, errorMessage, isSlackDmChannel } from "./utils";

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
  private config: SlackDbConfig;
  private socketModeClient: SocketModeClient | null = null;
  private eventHandler: ChatOpsEventHandler | null = null;
  private socketDedup = new EventDedupMap();
  private missingScopes: string[] = [];
  private userNameCache = new LRUCacheManager<string>({
    maxSize: 500,
    defaultTtl: TimeInMs.Hour,
  });

  constructor(slackConfig: SlackDbConfig) {
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

  getConnectionMode(): ChatOpsConnectionMode {
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

    // Single raw fetch to auth.test — reads both the JSON body (user/team info)
    // and the x-oauth-scopes response header (scope validation) in one API call.
    // The SDK's auth.test() doesn't expose response headers.
    try {
      const response = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      const body = await response.json();
      if (!body.ok) {
        throw new Error(body.error || "auth.test returned ok=false");
      }

      this.botUserId = (body.user_id as string) || null;
      this.teamId = (body.team_id as string) || null;
      this.teamName = (body.team as string) || null;
      logger.info(
        { botUserId: this.botUserId, teamId: this.teamId },
        "[SlackProvider] Authenticated successfully",
      );

      // Check granted scopes from the same response (non-fatal)
      this.parseGrantedScopes(response.headers.get("x-oauth-scopes"));
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
    if (!cleanedText && event.type !== "app_mention") {
      return null;
    }

    const threadTs = event.thread_ts || event.ts;

    // Download file attachments if present
    const attachments = await this.downloadSlackFiles(event.files);

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
      ...(attachments.length > 0 && { attachments }),
    };
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    if (!this.client) {
      throw new Error("SlackProvider not initialized");
    }

    const mrkdwn = slackifyMarkdown(options.text);

    // Slack section blocks have a 3000-char limit; split long responses
    // into multiple blocks to avoid silent truncation.
    // biome-ignore lint/suspicious/noExplicitAny: Block Kit types are complex; shape is correct
    const blocks: any[] = [];
    const SECTION_LIMIT = 3000;
    if (mrkdwn.length <= SECTION_LIMIT) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: mrkdwn },
      });
    } else {
      // Split on double-newline boundaries to keep paragraphs intact
      let remaining = mrkdwn;
      while (remaining.length > 0) {
        if (remaining.length <= SECTION_LIMIT) {
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: remaining },
          });
          break;
        }
        // Find last double-newline within the limit
        let splitAt = remaining.lastIndexOf("\n\n", SECTION_LIMIT);
        if (splitAt <= 0) {
          // Fall back to last single newline
          splitAt = remaining.lastIndexOf("\n", SECTION_LIMIT);
        }
        if (splitAt <= 0) {
          // No good break point — hard split
          splitAt = SECTION_LIMIT;
        }
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: remaining.slice(0, splitAt) },
        });
        remaining = remaining.slice(splitAt).trim();
      }
    }

    if (options.footer) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "plain_text",
            text: options.footer,
            emoji: true,
          },
        ],
      });
    }

    const result = await this.client.chat.postMessage({
      channel: options.originalMessage.channelId,
      text: mrkdwn,
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

    const agentDropdown = {
      type: "actions" as const,
      elements: [
        {
          type: "static_select" as const,
          action_id: "select_agent",
          placeholder: {
            type: "plain_text" as const,
            text: "Choose an agent…",
          },
          options: params.agents.map((agent) => ({
            text: { type: "plain_text" as const, text: agent.name },
            value: agent.id,
          })),
        },
      ],
    };

    const blocks: Record<string, unknown>[] = params.isWelcome
      ? [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Each Slack channel needs a *default agent* assigned to it. This agent will handle all your requests in this channel by default.",
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
          agentDropdown,
        ]
      : [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Change Default Agent*\nSelect a different agent to handle messages in this channel:",
            },
          },
          agentDropdown,
        ];

    const isDM = params.message.metadata?.channelType === "im";
    const fallbackText = params.isWelcome
      ? "Welcome to Archestra!"
      : "Change Default Agent";

    if (isDM) {
      // In DMs, thread the reply to the user's message so it appears in Chat tab.
      // Top-level postMessage without thread_ts goes to History.
      await this.client.chat.postMessage({
        channel: params.message.channelId,
        text: fallbackText,
        // biome-ignore lint/suspicious/noExplicitAny: Block Kit types are complex; shape is correct
        blocks: blocks as any,
        ...(params.message.threadId
          ? { thread_ts: params.message.threadId }
          : {}),
      });
    } else {
      await this.client.chat.postEphemeral({
        channel: params.message.channelId,
        user: params.message.senderId,
        text: fallbackText,
        // biome-ignore lint/suspicious/noExplicitAny: Block Kit types are complex; shape is correct
        blocks: blocks as any,
      });
    }
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
      // Fetch all messages using cursor-based pagination
      const allMessages: NonNullable<
        Awaited<ReturnType<WebClient["conversations"]["replies"]>>["messages"]
      > = [];
      let cursor: string | undefined;

      do {
        const result = await this.client.conversations.replies({
          channel: params.channelId,
          ts: params.threadId,
          limit,
          cursor,
        });
        allMessages.push(...(result.messages || []));
        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor && allMessages.length < limit);

      // Trim to the requested limit
      const trimmedMessages = allMessages.slice(0, limit);

      const filtered = trimmedMessages.filter(
        (msg) => msg.ts && msg.ts !== params.excludeMessageId && msg.text,
      );

      // Batch-resolve unique non-bot user IDs to display names
      const userIds = [
        ...new Set(
          filtered
            .filter(
              (msg) => msg.user && !msg.bot_id && msg.user !== this.botUserId,
            )
            .map((msg) => msg.user as string),
        ),
      ];
      const userNameMap = await this.resolveUserNames(userIds);

      const threadMessages = filtered.map((msg) => {
        // Extract file metadata from Slack message files
        const files = (msg.files as SlackFile[] | undefined)
          ?.filter((f) => f.url_private_download || f.url_private)
          .map((f) => ({
            url: (f.url_private_download || f.url_private) as string,
            mimetype: f.mimetype || "application/octet-stream",
            name: f.name,
            size: f.size,
          }));

        const isFromBot = Boolean(msg.bot_id) || msg.user === this.botUserId;
        const senderName = isFromBot
          ? msg.user || "Unknown"
          : userNameMap.get(msg.user as string) || msg.user || "Unknown";

        return {
          messageId: msg.ts as string,
          senderId: msg.user || msg.bot_id || "unknown",
          senderName,
          text: msg.text || "",
          timestamp: new Date(Number.parseFloat(msg.ts as string) * 1000),
          isFromBot,
          ...(files && files.length > 0 && { files }),
        };
      });

      return threadMessages.sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
      );
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

  async getUserName(userId: string): Promise<string | null> {
    if (!this.client) return null;

    try {
      const result = await this.client.users.info({ user: userId });
      return (
        result.user?.real_name ||
        result.user?.profile?.display_name ||
        result.user?.name ||
        null
      );
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), userId },
        "[SlackProvider] Failed to get user name",
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
      // Paginate through all channels using cursor-based pagination.
      // Slack API returns at most `limit` channels per page (max 999).
      const allChannels: NonNullable<
        Awaited<ReturnType<WebClient["conversations"]["list"]>>["channels"]
      > = [];
      let cursor: string | undefined;

      do {
        const result = await this.client.conversations.list({
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 999,
          cursor,
        });
        allChannels.push(...(result.channels || []));
        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      // Only include channels where the bot is a member
      return allChannels
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
    if (action.action_id !== "select_agent" || !action.selected_option?.value) {
      return null;
    }

    return {
      agentId: action.selected_option.value,
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

    let user = await UserModel.findByEmail(senderEmail.toLowerCase());
    if (!user) {
      // Auto-provision: create user + member from slash command
      const displayName =
        (await this.getUserName(userId)) || body.user_name || "Unknown User";
      const { invitationId } = await autoProvisionUser({
        email: senderEmail,
        name: displayName,
        provider: "slack",
      });
      user = await UserModel.findByEmail(senderEmail.toLowerCase());
      if (!user) {
        return {
          response_type: "ephemeral",
          text: "Something went wrong while setting up your account. Please try again.",
        };
      }

      // Send welcome DM (fire-and-forget) — skip when SSO is enabled
      if (!(await isSsoConfigured())) {
        const welcome = buildWelcomeMessage({
          invitationId,
          email: senderEmail,
          name: displayName,
        });
        this.sendDirectMessage({
          userId,
          text: welcome.text,
          actionUrl: welcome.actionUrl,
          actionLabel: welcome.actionLabel,
        }).catch(() => {});
      }
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
            "Or just send a message to interact with the assigned agent.",
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
              `This channel is assigned to agent: *${agent?.name || binding.agentId}*\n\n` +
              "*Tip:* You can use other agents with the syntax *AgentName >* (e.g., @Archestra Sales > what's the status?).\n\n" +
              "Use `/archestra-select-agent` to change the default agent.",
          };
        }

        return {
          response_type: "ephemeral",
          text: "No agent is assigned to this channel yet.\nSend any message to set up an agent assignment.",
        };
      }

      case SLACK_SLASH_COMMANDS.SELECT_AGENT: {
        // Send agent selection card (visible to all in channel)
        const isDm = isSlackDmChannel(channelId);
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
            isDm,
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

  async sendEphemeralMessage(params: {
    channelId: string;
    userId: string;
    text: string;
    threadId?: string;
  }): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.chat.postEphemeral({
        channel: params.channelId,
        user: params.userId,
        text: params.text,
        thread_ts: params.threadId,
      });
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[SlackProvider] Failed to send ephemeral message",
      );
    }
  }

  async sendDirectMessage(params: {
    userId: string;
    text: string;
    actionUrl?: string;
    actionLabel?: string;
    channelId?: string;
    threadId?: string;
  }): Promise<void> {
    if (!this.client) return;

    let dmChannelId = params.channelId;
    if (!dmChannelId) {
      // Open a DM channel with the user
      const dmResult = await this.client.conversations.open({
        users: params.userId,
      });
      dmChannelId = dmResult.channel?.id;
      if (!dmChannelId) {
        logger.warn(
          { userId: params.userId },
          "[SlackProvider] Failed to open DM channel",
        );
        return;
      }
    }

    // biome-ignore lint/suspicious/noExplicitAny: Block Kit types are complex; shape is correct
    const blocks: any[] = [
      {
        type: "section",
        text: { type: "mrkdwn", text: params.text },
      },
    ];

    if (params.actionUrl && params.actionLabel) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: params.actionLabel, emoji: true },
            url: params.actionUrl,
            style: "primary",
          },
        ],
      });
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `Link: ${params.actionUrl}` }],
      });
    }

    await this.client.chat.postMessage({
      channel: dmChannelId,
      text: params.text,
      blocks,
      ...(params.threadId ? { thread_ts: params.threadId } : {}),
    });
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

  async downloadFiles(
    files: ChatThreadMessageFile[],
  ): Promise<
    Array<{ contentType: string; contentBase64: string; name?: string }>
  > {
    // Convert ChatThreadMessageFile[] to SlackFile[] and reuse existing download logic
    const slackFiles: SlackFile[] = files.map((f) => ({
      id: f.name || "unknown",
      name: f.name,
      mimetype: f.mimetype,
      size: f.size,
      url_private_download: f.url,
    }));
    return this.downloadSlackFiles(slackFiles);
  }

  getBotUserId(): string | null {
    return this.botUserId;
  }

  hasMissingScopes(): boolean {
    return this.missingScopes.length > 0;
  }

  /**
   * Send a rate-limited notification to a Slack thread when missing scopes
   * are detected. Throttled to at most once per 30 days per workspace.
   */
  async notifyMissingScopes(message: IncomingChatMessage): Promise<void> {
    if (this.missingScopes.length === 0 || !this.client) return;

    const cacheKey: AllowedCacheKey = `${CacheKey.SlackScopeNotification}-${this.teamId ?? "unknown"}`;
    const alreadyNotified = await cacheManager.get<boolean>(cacheKey);
    if (alreadyNotified) return;

    const scopeList = this.missingScopes.map((s) => `  • \`${s}\``).join("\n");

    const appSettingsUrl =
      this.config.appId && this.teamId
        ? `https://app.slack.com/app-settings/${this.teamId}/${this.config.appId}/oauth`
        : "https://api.slack.com/apps";

    const text = [
      ":warning: *Your Archestra Slack app is missing required scopes*",
      "",
      "The following scopes need to be added to your Slack app:",
      scopeList,
      "",
      "*To update your app:*",
      `1. Open your <${appSettingsUrl}|Slack app settings>`,
      "2. Go to *OAuth & Permissions* → *Scopes* → *Bot Token Scopes*",
      "3. Add the missing scopes listed above",
      "4. Click *Reinstall to Workspace* to apply the changes",
    ].join("\n");

    try {
      await this.client.chat.postMessage({
        channel: message.channelId,
        text,
        thread_ts: message.threadId,
      });

      // Throttle: don't send again for 30 days
      cacheManager.set(cacheKey, true, TimeInMs.Day * 30).catch(() => {});
    } catch (error) {
      logger.debug(
        { error: errorMessage(error) },
        "[SlackProvider] Failed to send missing-scope notification (non-fatal)",
      );
    }
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

  /**
   * Download files attached to a Slack message and convert to A2AAttachment format.
   * Uses the bot token to authenticate downloads from Slack's private URLs.
   * Enforces size limits to prevent excessive memory usage.
   */
  private async downloadSlackFiles(
    files?: SlackFile[],
  ): Promise<
    Array<{ contentType: string; contentBase64: string; name?: string }>
  > {
    if (!files || files.length === 0 || !this.client) return [];

    const filesToProcess = files.slice(
      0,
      CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE,
    );
    const results: Array<{
      contentType: string;
      contentBase64: string;
      name?: string;
    }> = [];
    let totalSize = 0;

    for (const file of filesToProcess) {
      const downloadUrl = file.url_private_download || file.url_private;
      if (!downloadUrl) {
        logger.debug(
          { fileId: file.id, fileName: file.name },
          "[SlackProvider] Skipping file without download URL",
        );
        continue;
      }

      // Skip files that exceed individual size limit
      if (
        file.size &&
        file.size > CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE
      ) {
        logger.info(
          {
            fileId: file.id,
            fileName: file.name,
            size: file.size,
            maxSize: CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE,
          },
          "[SlackProvider] Skipping file exceeding size limit",
        );
        continue;
      }

      // Skip if total size would exceed limit
      if (
        file.size &&
        totalSize + file.size >
          CHATOPS_ATTACHMENT_LIMITS.MAX_TOTAL_ATTACHMENTS_SIZE
      ) {
        logger.info(
          {
            fileId: file.id,
            fileName: file.name,
            totalSize,
            maxTotalSize: CHATOPS_ATTACHMENT_LIMITS.MAX_TOTAL_ATTACHMENTS_SIZE,
          },
          "[SlackProvider] Skipping file - total attachments size limit reached",
        );
        break;
      }

      try {
        // Only send the bot token to known Slack domains to prevent token leakage via SSRF
        if (!isSlackFileUrl(downloadUrl)) {
          logger.warn(
            { fileId: file.id, url: downloadUrl },
            "[SlackProvider] Skipping file from non-Slack domain",
          );
          continue;
        }

        // Slack redirects files.slack.com → files-origin.slack.com.
        // Node's fetch strips the Authorization header on cross-origin redirects,
        // so we follow redirects manually to re-attach the token.
        const response = await fetchSlackFile(
          downloadUrl,
          this.config.botToken,
        );

        if (!response.ok) {
          logger.warn(
            {
              fileId: file.id,
              fileName: file.name,
              status: response.status,
            },
            "[SlackProvider] Failed to download file",
          );
          continue;
        }

        // Verify we got a file, not an HTML error/login page
        const responseContentType = response.headers.get("content-type") || "";
        if (responseContentType.includes("text/html")) {
          logger.warn(
            {
              fileId: file.id,
              fileName: file.name,
              contentType: responseContentType,
            },
            "[SlackProvider] Received HTML instead of file — bot may be missing files:read scope",
          );
          continue;
        }

        // Pre-check Content-Length to avoid buffering oversized files
        const contentLength = Number.parseInt(
          response.headers.get("content-length") || "0",
          10,
        );
        if (
          contentLength > 0 &&
          contentLength > CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE
        ) {
          logger.info(
            { fileId: file.id, contentLength },
            "[SlackProvider] Skipping oversized attachment (Content-Length)",
          );
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        // Double-check actual size against individual limit
        if (buffer.length > CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE) {
          logger.info(
            { fileId: file.id, actualSize: buffer.length },
            "[SlackProvider] Downloaded file exceeds size limit, skipping",
          );
          continue;
        }

        // Post-download total size check (handles case where file.size was missing/zero)
        if (
          totalSize + buffer.length >
          CHATOPS_ATTACHMENT_LIMITS.MAX_TOTAL_ATTACHMENTS_SIZE
        ) {
          logger.info(
            {
              fileId: file.id,
              fileName: file.name,
              totalSize,
              maxTotalSize:
                CHATOPS_ATTACHMENT_LIMITS.MAX_TOTAL_ATTACHMENTS_SIZE,
            },
            "[SlackProvider] Total attachments size limit reached (post-download)",
          );
          break;
        }

        totalSize += buffer.length;
        results.push({
          contentType: file.mimetype || "application/octet-stream",
          contentBase64: buffer.toString("base64"),
          name: file.name,
        });

        logger.debug(
          {
            fileId: file.id,
            fileName: file.name,
            contentType: file.mimetype,
            size: buffer.length,
          },
          "[SlackProvider] Downloaded file attachment",
        );
      } catch (error) {
        logger.warn(
          { fileId: file.id, fileName: file.name, error: errorMessage(error) },
          "[SlackProvider] Error downloading file",
        );
      }
    }

    if (results.length > 0) {
      logger.info(
        {
          fileCount: results.length,
          totalSize,
          originalFileCount: files.length,
        },
        "[SlackProvider] Downloaded file attachments from Slack message",
      );
    }

    return results;
  }

  /**
   * Parse the x-oauth-scopes header from auth.test and detect missing scopes.
   * Non-fatal — silently skips if the header is absent.
   */
  private parseGrantedScopes(scopeHeader: string | null): void {
    if (!scopeHeader) {
      logger.debug(
        "[SlackProvider] No x-oauth-scopes header in auth.test response",
      );
      return;
    }

    const grantedScopes = new Set(scopeHeader.split(",").map((s) => s.trim()));
    const missing = SLACK_REQUIRED_BOT_SCOPES.filter(
      (s) => !grantedScopes.has(s),
    );

    if (missing.length > 0) {
      this.missingScopes = missing;
      logger.warn(
        { missingScopes: missing },
        "[SlackProvider] Bot token is missing required scopes. Some features (e.g., file downloads) may not work.",
      );
    } else {
      logger.debug("[SlackProvider] All required scopes are granted");
    }
  }

  /**
   * Batch-resolve Slack user IDs to display names using the LRU cache.
   * Falls back to the raw user ID if resolution fails.
   */
  private async resolveUserNames(
    userIds: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const uncachedIds: string[] = [];

    // Check cache first
    for (const id of userIds) {
      const cached = this.userNameCache.get(id);
      if (cached) {
        result.set(id, cached);
      } else {
        uncachedIds.push(id);
      }
    }

    // Resolve uncached IDs via Slack API
    const resolutions = await Promise.allSettled(
      uncachedIds.map(async (id) => {
        const name = await this.getUserName(id);
        return { id, name };
      }),
    );

    for (const resolution of resolutions) {
      if (resolution.status === "fulfilled") {
        const { id, name } = resolution.value;
        const displayName = name || id;
        this.userNameCache.set(id, displayName);
        result.set(id, displayName);
      }
    }

    return result;
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
 * Check whether a URL points to a known Slack file-hosting domain.
 * Prevents leaking the bot token to arbitrary URLs via SSRF.
 */
function isSlackFileUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname === "files.slack.com" || hostname === "files-origin.slack.com"
    );
  } catch {
    return false;
  }
}

/**
 * Fetch a file from Slack, manually following redirects to preserve the
 * Authorization header. Slack redirects files.slack.com to
 * files-origin.slack.com (a different origin), and Node's fetch strips
 * the Authorization header on cross-origin redirects per spec.
 * We follow up to 5 redirects, re-attaching the token on each hop
 * as long as the target remains a known Slack domain.
 */
async function fetchSlackFile(
  url: string,
  botToken: string,
): Promise<Response> {
  const maxRedirects = 5;
  let currentUrl = url;

  for (let i = 0; i <= maxRedirects; i++) {
    const headers: Record<string, string> = {};
    if (isSlackFileUrl(currentUrl)) {
      headers.Authorization = `Bearer ${botToken}`;
    }

    const response = await fetch(currentUrl, {
      headers,
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      currentUrl = location;
      continue;
    }

    return response;
  }

  // If we exhausted redirects, do a final attempt with auth if still a Slack domain
  const headers: Record<string, string> = {};
  if (isSlackFileUrl(currentUrl)) {
    headers.Authorization = `Bearer ${botToken}`;
  }
  return fetch(currentUrl, {
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    redirect: "follow",
  });
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

interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

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
    files?: SlackFile[];
  };
  challenge?: string;
}

interface SlackInteractivePayload {
  type: string;
  actions?: Array<{
    action_id: string;
    value?: string;
    selected_option?: { value: string };
  }>;
  user?: { id: string; name: string };
  channel?: { id: string };
  team?: { id: string };
  message?: { ts: string; thread_ts?: string };
  response_url?: string;
}
