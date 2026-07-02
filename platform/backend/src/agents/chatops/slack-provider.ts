import { createHmac, timingSafeEqual } from "node:crypto";
import {
  buildSlackSlashCommandsForCommand,
  getSlackSlashCommandAction,
  SLACK_REQUIRED_BOT_SCOPES,
  SLACK_SLASH_COMMANDS,
  TimeInMs,
} from "@archestra/shared";
import { SocketModeClient } from "@slack/socket-mode";
import { type Button, type ColorScheme, WebClient } from "@slack/web-api";
import {
  type AllowedCacheKey,
  CacheKey,
  cacheManager,
  LRUCacheManager,
} from "@/cache-manager";
import logger from "@/logging";
import {
  AgentModel,
  ChatOpsChannelBindingModel,
  OrganizationModel,
} from "@/models";
import type {
  AddApprovalRequestFormOptions,
  ChatOpsApprovalDecision,
  ChatOpsConnectionMode,
  ChatOpsEventHandler,
  ChatOpsProvider,
  ChatOpsProviderType,
  ChatReplyOptions,
  ChatThreadMessage,
  ChatThreadMessageFile,
  DiscoveredChannel,
  IncomingChatMessage,
  SkippedAttachment,
  SlackDbConfig,
  ThreadHistoryParams,
  UpdateApprovalRequestOptions,
} from "@/types";
import { shrinkImageForModel } from "@/utils/image-conversion";
import {
  buildWelcomeMessage,
  ensureProvisionedUser,
  isSsoConfigured,
} from "./auto-provision";
import {
  clearChannelThreadActive,
  isChannelThreadActive,
  isMuteReaction,
  isThreadMuteCommand,
  markChannelThreadActive,
  mightBeAddressedMuteCommand,
  resolveChannelGateAction,
} from "./channel-activation";
import {
  buildThreadMutedNotice,
  CHATOPS_ATTACHMENT_LIMITS,
  CHATOPS_THREAD_HISTORY,
  SLACK_DEFAULT_CONNECTION_MODE,
} from "./constants";
import {
  EventDedupMap,
  errorMessage,
  formatApprovalToolArgs,
  isSlackDmChannel,
} from "./utils";

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

  async handleInteractivePayload(payload: unknown): Promise<void> {
    const approvalDecision = this.parseApprovalPayload(payload);
    if (approvalDecision) {
      await this.eventHandler?.handleInteractiveApprovalDecision(
        this,
        approvalDecision,
      );
      return;
    }

    const selection = this.parseInteractivePayload(payload);
    if (!selection) return;

    await this.eventHandler?.handleInteractiveSelection(this, payload);
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

    // Reaction-based mute: reacting with 🔇/🤫 on one of the bot's OWN channel
    // replies mutes that thread. Pure side effect — never forwarded to the agent.
    if (event.type === "reaction_added") {
      await this.handleMuteReaction(event);
      return null;
    }

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
    const threadTs = event.thread_ts || event.ts;
    const hasBotMention =
      event.type === "app_mention" ||
      Boolean(this.botUserId && text.includes(`<@${this.botUserId}>`));
    const cleanedText = this.cleanBotMention(text);

    // Channel auto-reply gate: in channels the bot stays quiet until
    // @mentioned (app_mention event or message text containing <@BOT_ID>),
    // then keeps replying to that thread without further mentions until the
    // activation TTL lapses. DMs are always processed without a mention.
    //
    // A user can end the sticky behavior early by sending a mute command (e.g.
    // "@bot mute"). It's honored both when the bot is mentioned and when the
    // thread is already active (so muting needs no re-mention), then the bot
    // stays quiet until @mentioned again.
    if (!isDM) {
      const activation = {
        provider: this.providerId,
        channelId: event.channel,
        threadId: threadTs,
      };
      // "mute" / "shut up" etc., optionally prefixed by a name the bot answers
      // to ("Archestra shut up") with no explicit @mention. The app name is
      // DB-backed, so only resolve it when the message might be such a command.
      let wantsMute = isThreadMuteCommand(cleanedText);
      if (!wantsMute && mightBeAddressedMuteCommand(cleanedText)) {
        wantsMute = isThreadMuteCommand(cleanedText, [
          await OrganizationModel.getAppName(),
        ]);
      }
      // isActive is only consulted when the bot wasn't mentioned (see
      // resolveChannelGateAction), so skip the cache read on mentions.
      const isActive = hasBotMention
        ? false
        : await isChannelThreadActive(activation);
      switch (
        resolveChannelGateAction({
          botMentioned: hasBotMention,
          wantsMute,
          isActive,
        })
      ) {
        case "mute":
          await this.muteThreadAndNotify(event.channel, threadTs);
          return null;
        case "activate":
          await markChannelThreadActive(activation);
          break;
        case "ignore":
          return null;
        case "process":
          break;
      }
    }

    // Download file attachments first (we're already in an addressed context —
    // DM, mention, or active thread — gated above). A file-only message (empty
    // text) is kept when a file survived download OR was recorded as skipped —
    // a dropped file (too large, expired, failed) carries a model-visible note
    // so the bot can explain it rather than answering a blank turn. Only a
    // genuinely empty, attachment-less message is dropped here.
    const { attachments, skipped } = await this.downloadSlackFiles(event.files);
    if (
      !cleanedText &&
      event.type !== "app_mention" &&
      attachments.length === 0 &&
      skipped.length === 0
    ) {
      return null;
    }

    // Resolve display names in one LRU-cached batch: the sender (so prompts
    // say "ildar", not "U0966V5MTM4"), the bot itself (so the agent
    // recognizes messages addressing it by name, e.g. "Ildestra how are
    // you?"), and OTHER people @mentioned in the message — a message
    // @mentioning someone else is most likely addressed to them.
    const mentionedOtherIds = [
      ...new Set(
        [...text.matchAll(/<@([A-Z0-9]+)>/g)]
          .map((match) => match[1])
          .filter((id) => id !== this.botUserId),
      ),
    ];
    const idsToResolve = [
      ...(event.user ? [event.user] : []),
      ...(!isDM && this.botUserId ? [this.botUserId] : []),
      ...(!isDM ? mentionedOtherIds : []),
    ];
    const names = idsToResolve.length
      ? await this.resolveUserNames([...new Set(idsToResolve)])
      : new Map<string, string>();
    const senderName = event.user
      ? (names.get(event.user) ?? event.user)
      : "Unknown User";
    const botName = this.botUserId ? (names.get(this.botUserId) ?? null) : null;
    const mentionedOthers = !isDM
      ? mentionedOtherIds.map((id) => names.get(id) ?? id)
      : [];

    return {
      messageId: event.ts,
      channelId: event.channel,
      workspaceId: body.team_id || null,
      threadId: threadTs,
      senderId: event.user || "unknown",
      senderName,
      text: cleanedText,
      rawText: text,
      timestamp: new Date(Number.parseFloat(event.ts) * 1000),
      isThreadReply,
      metadata: {
        eventType: event.type,
        channelType: event.channel_type,
        // Lets the manager frame group conversations for the agent
        // ("personal", "groupChat", or "channel") and tell it whether it
        // was addressed — same vocabulary as the MS Teams provider.
        conversationType: isDM
          ? "personal"
          : event.channel_type === "mpim"
            ? "groupChat"
            : "channel",
        botMentioned: hasBotMention,
        ...(botName && botName !== this.botUserId && { botName }),
        ...(mentionedOthers.length > 0 && { mentionedOthers }),
      },
      ...(attachments.length > 0 && { attachments }),
      ...(skipped.length > 0 && { skippedAttachments: skipped }),
    };
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    if (!this.client) {
      throw new Error("SlackProvider not initialized");
    }

    // Slack expands `markdown` blocks server-side into Block Kit primitives
    // (one per heading, table, list, code block, paragraph) and rejects any
    // chat.postMessage whose expanded blocks[] exceeds 50. splitSlackMarkdownText
    // chunks the text so each chunk's estimated expansion stays under that cap;
    // we post one message per chunk and thread the follow-ups so the user sees
    // the full reply. Non-final messages reserve their footer slot for a
    // "continued in a message below" hint.
    const chunks = splitSlackMarkdownText(options.text);

    let firstTs = "";
    for (let i = 0; i < chunks.length; i++) {
      const isFinal = i === chunks.length - 1;
      const chunkText = chunks[i];

      // biome-ignore lint/suspicious/noExplicitAny: Block Kit types are complex; shape is correct
      const blocks: any[] = [{ type: "markdown", text: chunkText }];

      if (!isFinal) {
        blocks.push({
          type: "context",
          elements: [
            {
              type: "plain_text",
              text: "continued in a message below",
              emoji: true,
            },
          ],
        });
      } else {
        // An even-more-subtle hint (e.g. the one-time mute tip) sits on its own
        // context line ABOVE the agent footer, so the footer stays the last
        // line of the reply.
        if (options.hint) {
          blocks.push({
            type: "context",
            elements: [{ type: "plain_text", text: options.hint, emoji: true }],
          });
        }
        if (options.footer) {
          blocks.push({
            type: "context",
            elements: [
              { type: "plain_text", text: options.footer, emoji: true },
            ],
          });
        }
      }

      const fallbackText = truncateFallbackText(
        isFinal && options.footer
          ? `${chunkText}\n\n${options.footer}`
          : chunkText,
      );

      // Follow-ups thread under the first message when the original wasn't a
      // thread, so we don't spam the channel with N top-level posts.
      const threadTs =
        options.originalMessage.threadId ?? (firstTs || undefined);

      const postArgs = {
        channel: options.originalMessage.channelId,
        text: fallbackText,
        blocks,
        thread_ts: threadTs,
      };
      logger.debug(
        {
          postArgs,
          part: i + 1,
          of: chunks.length,
          estimatedRenderedBlocks: estimateRenderedBlocks(chunkText),
        },
        "[SlackProvider] chat.postMessage (sendReply)",
      );
      const result = await this.client.chat.postMessage(postArgs);
      if (i === 0) firstTs = (result.ts as string) || "";
    }

    return firstTs;
  }

  async addApprovalRequestForm(
    options: AddApprovalRequestFormOptions,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("SlackProvider not initialized");
    }

    const generateButton = (
      text: string,
      style: ColorScheme,
      approved: boolean,
      action: string,
    ): Button => {
      return {
        type: "button",
        text: {
          type: "plain_text",
          text,
          emoji: true,
        },
        action_id: `approval_decision_${options.approvalId}_${action}`,
        // Slack caps a button `value` at 2,000 chars and rejects oversized
        // chat.postMessage payloads with `msg_too_large`. Embedding the full
        // original message (text, rawText, base64 attachments, metadata) here
        // scales with user input and blew past that limit. The approve/decline
        // click path only needs the requester's email (authz check, not
        // recoverable from the click payload) plus channel/thread for replies.
        value: JSON.stringify({
          taskId: options.taskId,
          approvalId: options.approvalId,
          toolName: options.toolName,
          originalMessage: {
            channelId: options.originalMessage.channelId,
            threadId: options.originalMessage.threadId,
            senderEmail: options.originalMessage.senderEmail,
          },
          approved,
        }),
        style,
      };
    };

    const argsText = formatApprovalToolArgs(options.toolArgs);
    const postArgs = {
      channel: options.channelId,
      text: "",
      blocks: [
        {
          type: "section" as const,
          text: {
            type: "mrkdwn" as const,
            text: `\`${options.toolName}\``,
          },
        },
        ...(argsText
          ? [
              {
                type: "section" as const,
                text: {
                  type: "mrkdwn" as const,
                  text: `\`\`\`\n${argsText}\n\`\`\``,
                },
              },
            ]
          : []),
        {
          type: "actions" as const,
          elements: [
            generateButton("Approve", "primary", true, "approve"),
            generateButton("Decline", "danger", false, "decline"),
          ],
        },
      ],
      thread_ts: options.threadId,
    };
    logger.debug(
      { postArgs },
      "[SlackProvider] chat.postMessage (addApprovalRequestForm)",
    );
    await this.client.chat.postMessage(postArgs);
  }

  async updateApprovalRequest(
    options: UpdateApprovalRequestOptions,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("SlackProvider not initialized");
    }
    const status = options.approved
      ? ":white_check_mark: Approved"
      : ":x: Declined";
    await this.client.chat.update({
      channel: options.channelId,
      ts: options.messageKey,
      text: `\`${options.toolName}\`: ${status}`,
    });
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
              text:
                "*Available commands:*\n" +
                `\`${SLACK_SLASH_COMMANDS.SELECT_AGENT}\` — Change the default agent handling requests in the channel\n` +
                `\`${SLACK_SLASH_COMMANDS.STATUS}\` — Check the current agent handling requests in the channel\n` +
                `\`${SLACK_SLASH_COMMANDS.HELP}\` — Show available commands\n` +
                "`mute` — Reply with this (or `mute` me directly) to stop auto-replies in a thread; @mention me to resume",
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
      const postArgs = {
        channel: params.message.channelId,
        text: fallbackText,
        // biome-ignore lint/suspicious/noExplicitAny: Block Kit types are complex; shape is correct
        blocks: blocks as any,
        ...(params.message.threadId
          ? { thread_ts: params.message.threadId }
          : {}),
      };
      logger.debug(
        { postArgs },
        "[SlackProvider] chat.postMessage (changeAgent DM)",
      );
      await this.client.chat.postMessage(postArgs);
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

  async getMessagePermalink(params: {
    channelId: string;
    messageId: string;
  }): Promise<string | null> {
    if (!this.client) return null;
    try {
      const result = await this.client.chat.getPermalink({
        channel: params.channelId,
        message_ts: params.messageId,
      });
      return (result.permalink as string | undefined) ?? null;
    } catch (error) {
      logger.warn(
        {
          error: errorMessage(error),
          channelId: params.channelId,
          messageId: params.messageId,
        },
        "[SlackProvider] Failed to fetch chat.getPermalink",
      );
      return null;
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

  parseApprovalPayload(payload: unknown): ChatOpsApprovalDecision | null {
    const p = payload as SlackInteractivePayload;
    if (p.type !== "block_actions" || !p.actions?.length) {
      return null;
    }

    const action = p.actions[0];
    if (!action.action_id?.startsWith("approval_decision") || !action.value) {
      return null;
    }

    let parsedValue: {
      taskId?: string;
      approvalId?: string;
      approved?: boolean;
      toolName?: string;
      originalMessage?: Partial<IncomingChatMessage>;
    };
    try {
      parsedValue = JSON.parse(action.value) as {
        taskId?: string;
        approvalId?: string;
        approved?: boolean;
        toolName?: string;
        originalMessage?: Partial<IncomingChatMessage>;
      };
    } catch {
      return null;
    }

    if (
      !parsedValue.taskId ||
      !parsedValue.approvalId ||
      typeof parsedValue.approved !== "boolean" ||
      !parsedValue.originalMessage
    ) {
      return null;
    }

    const messageTs = p.message?.ts;
    if (!messageTs) {
      return null;
    }

    // The button value now carries only a slimmed-down original message (see
    // addApprovalRequestForm). Reconstruct a complete IncomingChatMessage,
    // falling back to the live interactive payload for ids and to safe defaults
    // for fields the click path doesn't read. Older in-flight buttons that
    // still carry a full message keep working unchanged.
    const embedded = parsedValue.originalMessage;
    const originalMessage: IncomingChatMessage = {
      messageId: embedded.messageId ?? "",
      channelId: embedded.channelId ?? p.channel?.id ?? "",
      workspaceId: embedded.workspaceId ?? p.team?.id ?? null,
      threadId: embedded.threadId ?? p.message?.thread_ts ?? p.message?.ts,
      senderId: embedded.senderId ?? "",
      senderEmail: embedded.senderEmail,
      senderName: embedded.senderName ?? "",
      text: embedded.text ?? "",
      rawText: embedded.rawText ?? "",
      timestamp: new Date(),
      isThreadReply: embedded.isThreadReply ?? false,
      metadata: embedded.metadata,
      attachments: embedded.attachments,
    };

    return {
      taskId: parsedValue.taskId,
      approvalId: parsedValue.approvalId,
      approved: parsedValue.approved,
      toolName: parsedValue.toolName || "",
      messageTs,
      channelId: p.channel?.id || "",
      workspaceId: p.team?.id || null,
      threadTs: p.message?.thread_ts || p.message?.ts,
      userId: p.user?.id || "unknown",
      userName: p.user?.name || "Unknown",
      responseUrl: p.response_url || "",
      originalMessage,
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
    const commandAction = getSlackSlashCommandAction(command);
    const slashCommands = buildSlackSlashCommandsForCommand(command);
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

    // Auto-provision: create user + member from slash command
    let displayName = "";
    const provisioned = await ensureProvisionedUser({
      email: senderEmail,
      resolveDisplayName: async () => {
        displayName =
          (await this.getUserName(userId)) || body.user_name || "Unknown User";
        return displayName;
      },
      provider: "slack",
    });
    if (!provisioned) {
      return {
        response_type: "ephemeral",
        text: "Something went wrong while setting up your account. Please try again.",
      };
    }

    // Send welcome DM (fire-and-forget) — skip when SSO is enabled
    if (provisioned.invitationId !== null && !(await isSsoConfigured())) {
      const welcome = await buildWelcomeMessage({
        invitationId: provisioned.invitationId,
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

    switch (commandAction) {
      case "HELP":
        return {
          response_type: "ephemeral",
          text:
            "*Available commands:*\n" +
            `\`${slashCommands.SELECT_AGENT}\` — Change the default agent\n` +
            `\`${slashCommands.STATUS}\` — Show current agent binding\n` +
            `\`${slashCommands.HELP}\` — Show this help message\n` +
            "`mute` — Reply with this in a thread to stop auto-replies there; @mention me to resume\n\n" +
            "Or just send a message to interact with the assigned agent.",
        };

      case "STATUS": {
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
              `Use \`${slashCommands.SELECT_AGENT}\` to change the default agent.`,
          };
        }

        return {
          response_type: "ephemeral",
          text: "No agent is assigned to this channel yet.\nSend any message to set up an agent assignment.",
        };
      }

      case "SELECT_AGENT": {
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
          text: `Unknown command. Use \`${slashCommands.HELP}\` to see available commands.`,
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

    const postArgs = {
      channel: dmChannelId,
      text: params.text,
      blocks,
      ...(params.threadId ? { thread_ts: params.threadId } : {}),
    };
    logger.debug(
      { postArgs },
      "[SlackProvider] chat.postMessage (sendDmNotification)",
    );
    await this.client.chat.postMessage(postArgs);
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

  async clearTypingStatus(channelId: string, threadTs: string): Promise<void> {
    if (!this.client) return;
    try {
      // Slack clears the assistant status when an empty string is set. Without
      // this, a deliberate no-reply leaves "is thinking..." spinning forever —
      // Slack only auto-clears the status when a message is posted.
      await this.client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status: "",
      });
    } catch (error) {
      logger.debug(
        { error: errorMessage(error) },
        "[SlackProvider] clearTypingStatus failed (non-fatal)",
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
    // History files are prior turns — surface only the downloaded attachments;
    // drops from history are not reported to the model.
    return (await this.downloadSlackFiles(slackFiles)).attachments;
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

    const appName = await OrganizationModel.getAppName();
    const text = [
      `:warning: *Your ${appName} Slack app is missing required scopes*`,
      "",
      "The following scopes need to be added to your Slack app:",
      scopeList,
      "",
      "Until they're added, some features may not work fully.",
      "",
      "*To update your app:*",
      `1. Open your <${appSettingsUrl}|Slack app settings>`,
      "2. Go to *OAuth & Permissions* → *Scopes* → *Bot Token Scopes*",
      "3. Add the missing scopes listed above",
      "4. Click *Reinstall to Workspace* to apply the changes",
    ].join("\n");

    try {
      const postArgs = {
        channel: message.channelId,
        text,
        thread_ts: message.threadId,
      };
      logger.debug(
        { postArgs },
        "[SlackProvider] chat.postMessage (notifyMissingScopes)",
      );
      await this.client.chat.postMessage(postArgs);

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
   * Mute a channel thread, confirming ONLY on a real active→muted transition.
   * Redelivered events / repeat mutes find the key already gone and stay silent.
   */
  private async muteThreadAndNotify(
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    const wasActive = await clearChannelThreadActive({
      provider: this.providerId,
      channelId,
      threadId: threadTs,
    });
    if (wasActive) {
      await this.postThreadMutedNotice(channelId, threadTs);
    }
  }

  /**
   * Mute a thread when a 🔇/🤫 reaction lands on one of the bot's OWN channel
   * messages. Slack reaction events carry only the reacted message's ts, not its
   * thread_ts, so we resolve the thread root (the activation key) via the API.
   */
  private async handleMuteReaction(event: SlackReactionEvent): Promise<void> {
    if (
      !this.botUserId ||
      event.item?.type !== "message" ||
      event.item_user !== this.botUserId ||
      !isMuteReaction(event.reaction ?? "")
    ) {
      return;
    }
    const channelId = event.item.channel;
    // DMs have no sticky activation to clear; skip the wasted API lookup.
    if (isSlackDmChannel(channelId)) return;

    const threadTs = await this.resolveThreadRoot(channelId, event.item.ts);
    if (!threadTs) return; // couldn't resolve — never claim a false "muted"
    await this.muteThreadAndNotify(channelId, threadTs);
  }

  /**
   * Resolve the thread root ts a message belongs to — the value the activation
   * key was written with. conversations.replies returns the thread's parent as
   * messages[0]; its ts (or thread_ts) is the root. Returns null on failure so
   * callers don't post a false confirmation.
   */
  private async resolveThreadRoot(
    channelId: string,
    ts: string,
  ): Promise<string | null> {
    if (!this.client) return null;
    try {
      const result = await this.client.conversations.replies({
        channel: channelId,
        ts,
        limit: 1,
      });
      const root = result.messages?.[0];
      return (
        (root?.thread_ts as string | undefined) ||
        (root?.ts as string | undefined) ||
        null
      );
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), channelId, ts },
        "[SlackProvider] Failed to resolve thread root for mute reaction",
      );
      return null;
    }
  }

  /** Confirm a thread was muted, threaded under the message that muted it. */
  private async postThreadMutedNotice(
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.chat.postMessage({
        channel: channelId,
        text: buildThreadMutedNotice(),
        thread_ts: threadTs,
      });
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[SlackProvider] Failed to post thread-muted notice",
      );
    }
  }

  /**
   * Handle a slash command received via socket mode.
   * Uses ack() to send the response directly (supported by the SocketModeClient).
   */
  private async handleSlashCommandSocket(
    body: unknown,
    ack: (response?: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
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

    // Deliver the response body to the user. Prefer ack() over the socket;
    // if the socket is mid-rotation the ack rejects, so fall back to
    // response_url (HTTP POST) which Slack guarantees is valid for ~30 min.
    const deliver = async (response: Record<string, unknown>) => {
      try {
        await ack(response);
        return;
      } catch (error) {
        logger.warn(
          { error: errorMessage(error), command: cmd.command },
          "[SlackProvider] Slash command ack failed; falling back to response_url",
        );
      }
      if (!cmd.response_url) {
        logger.error(
          { command: cmd.command },
          "[SlackProvider] No response_url for slash command; user will see no reply",
        );
        return;
      }
      try {
        await fetch(cmd.response_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(response),
        });
      } catch (error) {
        logger.error(
          { error: errorMessage(error), command: cmd.command },
          "[SlackProvider] Slash command response_url fallback failed",
        );
      }
    };

    try {
      const response = await this.handleSlashCommand(cmd);
      if (response) {
        await deliver(response as Record<string, unknown>);
      } else {
        // No body to deliver — just close Slack's spinner. If this ack
        // fails the user briefly sees a timeout; the side effect (e.g.
        // modal opened via trigger_id) already happened.
        try {
          await ack();
        } catch (error) {
          logger.warn(
            { error: errorMessage(error), command: cmd.command },
            "[SlackProvider] Empty slash command ack failed",
          );
        }
      }
    } catch (error) {
      logger.error(
        { error: errorMessage(error), command: cmd.command },
        "[SlackProvider] Slash command failed",
      );
      await deliver({
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
        // Slack rotates Socket Mode WebSockets on its own schedule. If the
        // socket goes non-ready between event receipt and our ack, the ack
        // promise rejects. Since this listener is async and EventEmitter does
        // not await it, an unguarded rejection becomes an unhandledRejection
        // and Node kills the process. Slack redelivers unacked events, so
        // swallowing the failure is safe.
        const safeAck = async (response?: Record<string, unknown>) => {
          try {
            await ack(response);
          } catch (error) {
            logger.warn(
              { error: errorMessage(error), type },
              "[SlackProvider] Failed to ack Socket Mode event (socket likely rotated); Slack will redeliver",
            );
          }
        };
        switch (type) {
          case "events_api": {
            await safeAck();
            // Messages carry event.ts; reaction events carry event.event_ts
            // instead — fall back to it so reactions dedup on redelivery too.
            const eventBody = body as {
              event?: { ts?: string; event_ts?: string };
            };
            const eventTs = eventBody?.event?.ts ?? eventBody?.event?.event_ts;
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
            await safeAck();
            this.handleInteractivePayload(body).catch((error) => {
              logger.error(
                { error: errorMessage(error) },
                "[SlackProvider] Error processing socket interactive event",
              );
            });
            break;
          case "slash_commands":
            // Pass the raw ack (not safeAck): handleSlashCommandSocket has its
            // own delivery helper that falls back to response_url when the ack
            // rejects, and it already returns a promise that is .catch()'d here.
            this.handleSlashCommandSocket(body, ack).catch((error) => {
              logger.error(
                { error: errorMessage(error) },
                "[SlackProvider] Error processing socket slash command",
              );
            });
            break;
          default:
            await safeAck();
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
  private async downloadSlackFiles(files?: SlackFile[]): Promise<{
    attachments: Array<{
      contentType: string;
      contentBase64: string;
      name?: string;
    }>;
    skipped: SkippedAttachment[];
  }> {
    if (!files || files.length === 0 || !this.client)
      return { attachments: [], skipped: [] };

    const filesToProcess = files.slice(
      0,
      CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE,
    );
    const results: Array<{
      contentType: string;
      contentBase64: string;
      name?: string;
    }> = [];
    // Files that were attached but not delivered, so the caller can tell the
    // model they existed (and why they were dropped) instead of denying them.
    const skipped: SkippedAttachment[] = [];
    // Anything past the per-message cap is dropped from processing; record it
    // rather than letting it vanish silently.
    for (const file of files.slice(
      CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE,
    )) {
      skipped.push({
        name: file.name,
        sizeBytes: file.size,
        reason: "too_many",
      });
    }
    let totalSize = 0;
    // Once the combined budget is spent, every remaining file is recorded as
    // over-budget rather than silently skipped (the old code `break`-ed here).
    let budgetExhausted = false;

    for (const file of filesToProcess) {
      if (budgetExhausted) {
        skipped.push({
          name: file.name,
          sizeBytes: file.size,
          reason: "total_limit_reached",
        });
        continue;
      }

      const downloadUrl = file.url_private_download || file.url_private;
      if (!downloadUrl) {
        logger.debug(
          { fileId: file.id, fileName: file.name },
          "[SlackProvider] Skipping file without download URL",
        );
        skipped.push({
          name: file.name,
          sizeBytes: file.size,
          reason: "download_failed",
        });
        continue;
      }

      // Oversized images are downloaded (up to the convertible ceiling) and
      // shrunk to fit the model's inline-image limit; everything else keeps the
      // flat per-file limit.
      const isImage = (file.mimetype || "").startsWith("image/");
      const perFileLimit = isImage
        ? CHATOPS_ATTACHMENT_LIMITS.MAX_CONVERTIBLE_IMAGE_SIZE
        : CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE;

      // Skip files that exceed individual size limit
      if (file.size && file.size > perFileLimit) {
        logger.info(
          {
            fileId: file.id,
            fileName: file.name,
            size: file.size,
            maxSize: perFileLimit,
          },
          "[SlackProvider] Skipping file exceeding size limit",
        );
        skipped.push({
          name: file.name,
          sizeBytes: file.size,
          reason: "too_large",
        });
        continue;
      }

      // Skip if total size would exceed limit. Images are exempt from this
      // pre-download check because their delivered size is the post-shrink
      // size (unknown until downloaded); they defer to the post-download total
      // check below on their final bytes.
      if (
        !isImage &&
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
        skipped.push({
          name: file.name,
          sizeBytes: file.size,
          reason: "total_limit_reached",
        });
        budgetExhausted = true;
        continue;
      }

      try {
        // Only send the bot token to known Slack domains to prevent token leakage via SSRF
        if (!isSlackFileUrl(downloadUrl)) {
          logger.warn(
            { fileId: file.id, url: downloadUrl },
            "[SlackProvider] Skipping file from non-Slack domain",
          );
          skipped.push({
            name: file.name,
            sizeBytes: file.size,
            reason: "download_failed",
          });
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
          skipped.push({
            name: file.name,
            sizeBytes: file.size,
            reason: "download_failed",
          });
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
          skipped.push({
            name: file.name,
            sizeBytes: file.size,
            reason: "download_failed",
          });
          continue;
        }

        // Pre-check Content-Length to avoid buffering oversized files
        const contentLength = Number.parseInt(
          response.headers.get("content-length") || "0",
          10,
        );
        if (contentLength > 0 && contentLength > perFileLimit) {
          logger.info(
            { fileId: file.id, contentLength },
            "[SlackProvider] Skipping oversized attachment (Content-Length)",
          );
          skipped.push({
            name: file.name,
            sizeBytes: file.size || contentLength,
            reason: "too_large",
          });
          continue;
        }

        let buffer: Buffer = Buffer.from(await response.arrayBuffer());
        let contentType = file.mimetype || "application/octet-stream";

        // Double-check actual size against individual limit
        if (buffer.length > perFileLimit) {
          logger.info(
            { fileId: file.id, actualSize: buffer.length },
            "[SlackProvider] Downloaded file exceeds size limit, skipping",
          );
          skipped.push({
            name: file.name,
            sizeBytes: buffer.length,
            reason: "too_large",
          });
          continue;
        }

        // Shrink an image that is too large for the model's inline limit
        // (covers both >10 MB images downloaded for conversion and images in
        // the 3.75–10 MB band). If it can't be brought under the limit, report
        // it rather than sending an image the provider will reject.
        if (
          isImage &&
          buffer.length > CHATOPS_ATTACHMENT_LIMITS.MAX_MODEL_INLINE_IMAGE_SIZE
        ) {
          const shrunk = await shrinkImageForModel(buffer, {
            maxBytes: CHATOPS_ATTACHMENT_LIMITS.MAX_MODEL_INLINE_IMAGE_SIZE,
            maxDimension:
              CHATOPS_ATTACHMENT_LIMITS.MAX_MODEL_INLINE_IMAGE_DIMENSION,
          });
          if (!shrunk) {
            logger.info(
              { fileId: file.id, fileName: file.name, size: buffer.length },
              "[SlackProvider] Could not shrink oversized image, skipping",
            );
            skipped.push({
              name: file.name,
              sizeBytes: buffer.length,
              reason: "too_large",
            });
            continue;
          }
          buffer = shrunk.buffer;
          contentType = shrunk.contentType;
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
          skipped.push({
            name: file.name,
            sizeBytes: buffer.length,
            reason: "total_limit_reached",
          });
          budgetExhausted = true;
          continue;
        }

        totalSize += buffer.length;
        results.push({
          contentType,
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
        skipped.push({
          name: file.name,
          sizeBytes: file.size,
          reason: "download_failed",
        });
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

    return { attachments: results, skipped };
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

// Slack's `markdown` block has a 12,000-char limit per block.
const MARKDOWN_BLOCK_CHAR_LIMIT = 12_000;

// Slack's chat.postMessage `text` is only a notification/accessibility fallback
// — the rendered reply lives in `blocks`. Slack rejects oversized payloads with
// `msg_too_large`, so cap the fallback well below Slack's ~40,000-char text
// limit instead of duplicating the full (already block-rendered) chunk into it.
const SLACK_FALLBACK_TEXT_LIMIT = 3_000;

function truncateFallbackText(text: string): string {
  if (text.length <= SLACK_FALLBACK_TEXT_LIMIT) return text;
  return `${text.slice(0, SLACK_FALLBACK_TEXT_LIMIT - 1)}…`;
}

// Slack rejects chat.postMessage with more than 50 expanded blocks. Each
// sendReply message reserves slots for context footers (a continuation hint, or
// the agent footer plus an optional one-time mute hint — at most 2), so the
// markdown block's expansion is bounded to 45, keeping the worst case (45 + 2)
// safely under the 50 ceiling against estimator drift.
const MAX_ESTIMATED_RENDERED_BLOCKS = 45;

/**
 * Estimate how many Block Kit blocks Slack will produce when rendering this
 * text inside a `markdown` block. Slack expands markdown server-side: each
 * heading, table, list, code block, and paragraph becomes its own block.
 *
 * Returns a conservative upper bound (≥ 1) used by splitSlackMarkdownText to
 * keep each message under Slack's 50-block-per-message cap.
 */
function estimateRenderedBlocks(text: string): number {
  const lines = text.split("\n");
  let count = 0;
  let inCodeBlock = false;
  let inTable = false;
  let inList = false;
  let pendingParagraph = false;

  const flushParagraph = () => {
    if (pendingParagraph) {
      count += 1;
      pendingParagraph = false;
    }
  };
  const flushTable = () => {
    if (inTable) {
      count += 1;
      inTable = false;
    }
  };
  const flushList = () => {
    if (inList) {
      count += 1;
      inList = false;
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        count += 1;
        inCodeBlock = false;
      } else {
        flushParagraph();
        flushTable();
        flushList();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) continue;

    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      flushTable();
      flushList();
      continue;
    }

    if (/^#{1,6}\s/.test(trimmed)) {
      flushParagraph();
      flushTable();
      flushList();
      count += 1;
      continue;
    }

    if (trimmed.startsWith("|")) {
      if (!inTable) {
        flushParagraph();
        flushList();
        inTable = true;
      }
      continue;
    }
    if (inTable) flushTable();

    if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      if (!inList) {
        flushParagraph();
        inList = true;
      }
      continue;
    }
    if (inList) flushList();

    pendingParagraph = true;
  }

  flushParagraph();
  flushTable();
  flushList();
  if (inCodeBlock) count += 1;

  return Math.max(count, 1);
}

/**
 * Split text into chunks where each chunk fits in one Slack message:
 * - text length ≤ MARKDOWN_BLOCK_CHAR_LIMIT (the markdown block's char cap)
 * - estimated rendered blocks ≤ MAX_ESTIMATED_RENDERED_BLOCKS (under Slack's
 *   50-block-per-message cap, after reserving 1 slot for a footer)
 *
 * Splits at paragraph (`\n\n`) boundaries to preserve markdown structure. A
 * single paragraph that exceeds the char limit falls back to a line-based hard
 * split; oversized-by-blocks paragraphs are exceedingly rare in LLM output
 * (would require dozens of headings with no blank lines between them) and are
 * also passed through hard-split as a best effort.
 */
function splitSlackMarkdownText(text: string): string[] {
  if (
    text.length <= MARKDOWN_BLOCK_CHAR_LIMIT &&
    estimateRenderedBlocks(text) <= MAX_ESTIMATED_RENDERED_BLOCKS
  ) {
    return [text];
  }

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferChars = 0;
  let bufferBlocks = 0;

  const flushBuffer = () => {
    if (buffer.length > 0) {
      chunks.push(buffer.join("\n\n"));
      buffer = [];
      bufferChars = 0;
      bufferBlocks = 0;
    }
  };

  for (const para of paragraphs) {
    if (para.length === 0) continue;
    const paraBlocks = estimateRenderedBlocks(para);

    if (
      para.length > MARKDOWN_BLOCK_CHAR_LIMIT ||
      paraBlocks > MAX_ESTIMATED_RENDERED_BLOCKS
    ) {
      flushBuffer();
      for (const sub of hardSplitOversizedParagraph(para)) {
        chunks.push(sub);
      }
      continue;
    }

    const sep = buffer.length > 0 ? 2 : 0;
    const wouldExceedChars =
      bufferChars + sep + para.length > MARKDOWN_BLOCK_CHAR_LIMIT;
    const wouldExceedBlocks =
      bufferBlocks + paraBlocks > MAX_ESTIMATED_RENDERED_BLOCKS;

    if (buffer.length > 0 && (wouldExceedChars || wouldExceedBlocks)) {
      flushBuffer();
    }

    buffer.push(para);
    bufferChars += (buffer.length > 1 ? 2 : 0) + para.length;
    bufferBlocks += paraBlocks;
  }

  flushBuffer();
  return chunks.length > 0 ? chunks : [text];
}

function hardSplitOversizedParagraph(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MARKDOWN_BLOCK_CHAR_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", MARKDOWN_BLOCK_CHAR_LIMIT);
    if (splitAt <= 0) splitAt = MARKDOWN_BLOCK_CHAR_LIMIT;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trim();
  }
  return chunks;
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
    // reaction_added fields (channel/ts live under `item`, not at the top level)
    reaction?: string;
    item?: { type?: string; channel: string; ts: string };
    item_user?: string;
  };
  challenge?: string;
}

/** A Slack `reaction_added` event (subset we use). */
type SlackReactionEvent = NonNullable<SlackEventPayload["event"]>;

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
