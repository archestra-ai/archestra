import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  buildSlackSlashCommandsForCommand,
  getSlackSlashCommandAction,
  SLACK_REQUIRED_BOT_SCOPES,
  SLACK_SLASH_COMMANDS,
  TimeInMs,
} from "@archestra/shared";
import { SocketModeClient } from "@slack/socket-mode";
import { type Button, type ColorScheme, WebClient } from "@slack/web-api";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import {
  type AllowedCacheKey,
  CacheKey,
  cacheManager,
  LRUCacheManager,
} from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import {
  AgentModel,
  ChatOpsChannelBindingModel,
  OrganizationModel,
} from "@/models";
import ChatOpsProcessedMessageModel from "@/models/chatops-processed-message";
import type {
  AddApprovalRequestFormOptions,
  ChatOpsApprovalDecision,
  ChatOpsConnectionMode,
  ChatOpsEventHandler,
  ChatOpsProvider,
  ChatOpsProviderType,
  ChatOpsReplyStream,
  ChatReplyOptions,
  ChatThreadMessage,
  ChatThreadMessageFile,
  DiscoveredChannel,
  IncomingChatMessage,
  SkippedAttachment,
  SlackDbConfig,
  ThreadFileOutcome,
  ThreadHistoryParams,
  UpdateApprovalRequestOptions,
} from "@/types";
import { shrinkImageForModel } from "@/utils/image-conversion";
import {
  buildWelcomeMessage,
  ensureProvisionedUser,
  resolveSignupWelcomeMode,
} from "./auto-provision";
import {
  applyChannelGate,
  isChannelThreadActive,
  isChannelThreadMuted,
  isMuteReaction,
  muteChannelThread,
  stopChannelThreadReply,
} from "./channel-activation";
import {
  CHATOPS_ATTACHMENT_LIMITS,
  CHATOPS_THREAD_HISTORY,
  SLACK_DEFAULT_CONNECTION_MODE,
} from "./constants";
import { slackAppFactory } from "./slack-app-factory";
import { slackMessageText, slackThreadMessageText } from "./slack-message-text";
import { SlackReplyStream, updatePausedTasks } from "./slack-reply-stream";
import {
  EventDedupMap,
  errorMessage,
  footerWithoutAgentName,
  formatApprovalReviewText,
  formatApprovalToolArgs,
  isSlackDmChannel,
  Semaphore,
  stripDuplicateAgentFooter,
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

  readonly pinnedAgentId?: string;
  readonly stateScope?: string;

  private client: WebClient | null = null;
  private botUserId: string | null = null;
  /** The bot's bot id (B…), which marks its own messages in history. */
  private botId: string | null = null;
  /**
   * User ids of the other Slack bots this deployment runs in the workspace. A
   * message that @mentions one of them, and not this bot, is addressed to it.
   */
  private siblingBotUserIds = new Set<string>();
  private agentsWithOwnBot = new Set<string>();
  /**
   * The bot's name as Slack shows it, which is what someone types when they
   * address it without an @mention ("Archestra mute"). auth.test can't provide
   * it — for a bot token its `user` field is the literal string "bot" — so it is
   * resolved from the bot's own profile.
   */
  private botDisplayName: string | null = null;
  /** The bot's Slack username — what people type after @ to mention it. */
  private botHandle: string | null = null;
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
  /**
   * The suggested prompts last set per DM, so reopening the Messages tab does
   * not re-send an unchanged list on every open.
   */
  private suggestedPromptsCache = new LRUCacheManager<string>({
    maxSize: 1000,
    defaultTtl: TimeInMs.Hour,
  });
  /**
   * Each channel's purpose, "" for none. Short-lived, and dropped as soon as
   * Slack reports a purpose change in a channel the bot is in.
   */
  private channelDescriptionCache = new LRUCacheManager<string>({
    maxSize: 1000,
    defaultTtl: 10 * TimeInMs.Minute,
  });
  /**
   * Optional descriptions and startup acknowledgments must fail fast; the
   * default client can retry for minutes and hold the final reply back.
   */
  private bestEffortClient: WebClient | null = null;
  /**
   * Set once agents.sessions.setStatus is rejected (an app not yet on the
   * Agent messaging experience), so status updates go straight to the legacy
   * assistant.threads.setStatus instead of failing first every time.
   */
  private useLegacyThreadStatus = false;

  /**
   * @param options.pinnedAgentId - set for an additional Slack app that always
   *   answers as this agent (see SlackAgentBotConfig)
   */
  constructor(
    slackConfig: SlackDbConfig,
    options: { pinnedAgentId?: string } = {},
  ) {
    this.config = slackConfig;
    if (options.pinnedAgentId) {
      this.pinnedAgentId = options.pinnedAgentId;
      this.stateScope = `agent:${options.pinnedAgentId}`;
    }
  }

  setSiblingBotUserIds(userIds: string[]): void {
    this.siblingBotUserIds = new Set(
      userIds.filter((id) => id !== this.botUserId),
    );
  }

  /**
   * Agents that have their own Slack bot. The router bot (not pinned to an
   * agent) leaves "answer all messages" to them in the channels they own.
   */
  setAgentsWithOwnBot(agentIds: string[]): void {
    this.agentsWithOwnBot = new Set(agentIds);
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
    const argumentsView = this.parseViewArgumentsPayload(payload);
    if (argumentsView) {
      await this.openApprovalArgumentsView(argumentsView);
      return;
    }

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

    await slackAppFactory.ensureManifestScopes(this.config);
    const { botToken } = this.config;
    this.client = new WebClient(botToken);
    this.bestEffortClient = new WebClient(botToken, {
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: 3 * TimeInMs.Second,
    });

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
      this.botId = (body.bot_id as string) || null;
      this.teamId = (body.team_id as string) || null;
      this.teamName = (body.team as string) || null;
      // Best-effort: without it the bot simply stops answering to its own name.
      this.botDisplayName = this.botUserId
        ? await this.getUserName(this.botUserId)
        : null;
      // auth.test's `user` is the bot's username and needs no scope, so a
      // hand-made app without users:read still reports its real handle.
      this.botHandle =
        (this.botUserId ? await this.fetchUserHandle(this.botUserId) : null) ||
        (body.user as string) ||
        null;
      logger.info(
        {
          botUserId: this.botUserId,
          botDisplayName: this.botDisplayName,
          teamId: this.teamId,
        },
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

  getBotHandle(): string | null {
    return this.botHandle;
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
    this.bestEffortClient = null;
    this.botUserId = null;
    this.botId = null;
    this.botDisplayName = null;
    this.botHandle = null;
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

    // Agent-session and DM lifecycle events are side effects, never forwarded
    // to the agent: the Stop button, and the moments a DM opens (suggested
    // prompts).
    const workspaceId = body.team_id ?? this.teamId;
    switch (event.type) {
      case "reaction_added":
        await this.handleControlEvent(body, () =>
          this.handleMuteReaction(event),
        );
        return null;
      case "agent_session_stopped":
        await this.handleControlEvent(body, () =>
          this.handleSessionStopped(event),
        );
        return null;
      case "app_home_opened":
        // Agent messaging experience: the DM's Messages tab was opened.
        if (event.tab === "messages") {
          await this.setSuggestedPrompts({
            channelId: event.channel,
            workspaceId,
          });
        }
        return null;
      case "assistant_thread_started":
        // Legacy assistant experience: a new assistant thread was opened.
        if (event.assistant_thread) {
          await this.setSuggestedPrompts({
            channelId: event.assistant_thread.channel_id,
            threadTs: event.assistant_thread.thread_ts,
            workspaceId,
          });
        }
        return null;
    }

    // Only process message and app_mention events.
    if (event.type !== "message" && event.type !== "app_mention") {
      return null;
    }

    if (event.subtype === "channel_purpose" && event.channel) {
      this.channelDescriptionCache.delete(event.channel);
    }

    // Skip bot messages to avoid loops
    if (event.bot_id || event.subtype === "bot_message") {
      return null;
    }

    // Skip messages from the bot itself
    if (this.botUserId && event.user === this.botUserId) {
      return null;
    }

    const text = slackMessageText(event);
    const isThreadReply = Boolean(event.thread_ts);
    const isDM = event.channel_type === "im";
    const threadTs = event.thread_ts || event.ts;
    const hasBotMention =
      event.type === "app_mention" ||
      Boolean(this.botUserId && text.includes(`<@${this.botUserId}>`));
    const cleanedText = this.cleanBotMention(text);

    // Addressed to another of this deployment's bots (`@archestra_marketing`
    // in a thread this bot is also in): that bot answers, this one stays out.
    if (
      !hasBotMention &&
      [...text.matchAll(/<@([A-Z0-9]+)>/g)].some((match) =>
        this.siblingBotUserIds.has(match[1]),
      )
    ) {
      return null;
    }

    // Channel auto-reply gate: in channels the bot stays quiet until
    // @mentioned (app_mention event or message text containing <@BOT_ID>),
    // then keeps replying to that thread without further mentions until the
    // activation TTL lapses. DMs are always processed without a mention.
    //
    // Mute commands and mute reactions end sticky replies until the
    // bot is @mentioned again. Commands are handled before reaching the agent.
    //
    // A channel can also opt into answering EVERY message (a per-channel
    // "answer all messages" binding setting): a message the gate would normally
    // ignore is processed instead, unless that thread was muted. A bot pinned
    // to an agent does so only in channels assigned to that agent.
    if (!isDM) {
      // A redelivered mention must not reactivate a thread muted since the
      // original delivery. Reply deduplication happens after this gate.
      if (
        hasBotMention &&
        (await ChatOpsProcessedMessageModel.isProcessed(
          this.stateScope ? `${this.stateScope}:${event.ts}` : event.ts,
        ))
      )
        return null;
      const { proceed } = await applyChannelGate({
        provider: this.providerId,
        channelId: event.channel,
        threadId: threadTs,
        scope: this.stateScope,
        botMentioned: hasBotMention,
        text: cleanedText,
        botDisplayName: this.botDisplayName,
        ...(this.pinnedAgentId
          ? { pinnedAgentId: this.pinnedAgentId }
          : { agentsWithOwnBot: this.agentsWithOwnBot }),
        postMutedNotice: async () => {},
        resolveAnswerAllWorkspaceId: async () => body.team_id || null,
      });
      if (!proceed) return null;
    }

    // Download file attachments first (we're already in an addressed context —
    // DM, mention, or active thread — gated above). A file-only message (empty
    // text) is kept when a file survived download OR was recorded as skipped —
    // a dropped file (too large, expired, failed) carries a model-visible note
    // so the bot can explain it rather than answering a blank turn. Only a
    // genuinely empty, attachment-less message is dropped here. A bare mention
    // is kept in either event form: ingress dedup keeps whichever of message
    // and app_mention arrives first.
    const outcomes = await this.downloadSlackFiles(event.files);
    const attachments = outcomes.flatMap((o) =>
      o.status === "delivered" ? [o.attachment] : [],
    );
    const skipped = outcomes.flatMap((o) =>
      o.status === "skipped" ? [o.skipped] : [],
    );
    if (
      !cleanedText &&
      !hasBotMention &&
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
    return await this.postReply(options);
  }

  startReplyStream(message: IncomingChatMessage): ChatOpsReplyStream {
    const client = this.client;
    if (!client) {
      throw new Error("SlackProvider not initialized");
    }
    // Slack streams only into a thread; outside a DM it also needs the person
    // the stream answers.
    const isDM = message.metadata?.channelType === "im";
    const teamId = message.workspaceId ?? this.teamId;
    return new SlackReplyStream({
      client,
      channelId: message.channelId,
      threadTs: message.threadId ?? message.messageId,
      ...(!isDM &&
        teamId && {
          recipient: { userId: message.senderId, teamId },
        }),
      fitsOneMessage: (text) =>
        text.length <= MARKDOWN_BLOCK_CHAR_LIMIT &&
        estimateRenderedBlocks(text) <= MAX_ESTIMATED_RENDERED_BLOCKS,
      buildTrailingBlocks: (options) =>
        buildTrailingContextBlocks({
          ...options,
          footer: this.visibleFooter(options.footer),
        }),
      postReply: async (options, replaceTs) => {
        await this.postReply(
          { ...options, originalMessage: message },
          replaceTs,
        );
      },
    });
  }

  /**
   * Post a reply as one or more messages. With `replaceTs`, the first message
   * replaces that existing one (a streamed preview) instead of being posted.
   */
  private async postReply(
    options: ChatReplyOptions,
    replaceTs?: string,
  ): Promise<string> {
    const client = options.bestEffort ? this.bestEffortClient : this.client;
    if (!client) {
      throw new Error("SlackProvider not initialized");
    }

    // The model sometimes signs off with the branding footer itself, having
    // seen it on earlier bot replies replayed as thread history. Drop that echo
    // before anything else so the reply renders exactly one footer — and before
    // chunking, so an echo can't survive inside a chunk's markdown block.
    const body = options.footer
      ? stripDuplicateAgentFooter(options.text, options.footer)
      : options.text;

    const footer = this.visibleFooter(options.footer);

    // Slack expands `markdown` blocks server-side into Block Kit primitives
    // (one per heading, table, list, code block, paragraph) and rejects any
    // chat.postMessage whose expanded blocks[] exceeds 50. splitSlackMarkdownText
    // chunks the text so each chunk's estimated expansion stays under that cap;
    // we post one message per chunk and thread the follow-ups so the user sees
    // the full reply. Non-final messages reserve their footer slot for a
    // "continued in a message below" hint.
    const chunks = splitSlackMarkdownText(protectSlackUrlBoundaries(body));

    let firstTs = "";
    for (let i = 0; i < chunks.length; i++) {
      const isFinal = i === chunks.length - 1;
      const chunkText = chunks[i];

      // Slack rejects an empty `markdown` block, so a chunk left blank (a reply
      // that was nothing but an echoed footer) contributes no body block and
      // renders as the footer alone.
      // biome-ignore lint/suspicious/noExplicitAny: Block Kit types are complex; shape is correct
      const blocks: any[] = chunkText.trim()
        ? [{ type: "markdown", text: chunkText }]
        : [];

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
        blocks.push(...buildTrailingContextBlocks({ ...options, footer }));
      }

      // Nothing to say and nothing to stamp — skip the post rather than send
      // Slack an empty payload.
      if (blocks.length === 0) continue;

      const fallbackText = truncateFallbackText(
        isFinal && footer
          ? [chunkText, footer].filter((part) => part.trim()).join("\n\n")
          : chunkText,
      );

      // Follow-ups thread under the first message when the original wasn't a
      // thread, so we don't spam the channel with N top-level posts.
      const threadTs =
        options.originalMessage.threadId ?? (firstTs || undefined);

      if (i === 0 && replaceTs) {
        await client.chat.update({
          channel: options.originalMessage.channelId,
          ts: replaceTs,
          text: fallbackText,
          blocks,
        });
        firstTs = replaceTs;
        continue;
      }

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
      const result = await client.chat.postMessage(postArgs);
      if (i === 0) firstTs = (result.ts as string) || "";
    }

    return firstTs;
  }

  async uploadFileToThread(options: {
    channelId: string;
    threadId: string;
    filename: string;
    data: Buffer;
    comment?: string;
  }): Promise<void> {
    if (!this.client) {
      throw new Error("SlackProvider not initialized");
    }
    // files.uploadV2 shares the file into the thread; Slack renders video and
    // image uploads natively, which a plain link cannot.
    await this.client.files.uploadV2({
      channel_id: options.channelId,
      thread_ts: options.threadId,
      filename: options.filename,
      file: options.data,
      ...(options.comment ? { initial_comment: options.comment } : {}),
    });
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

    // The arguments stay out of the message: "View arguments" opens them in
    // a modal. A review without a structured tool shows its own text instead,
    // and the remedy call's arguments it would otherwise get only name the plan.
    const hasArgs =
      !options.reviewText &&
      !!options.toolArgs &&
      Object.keys(options.toolArgs).length > 0;
    const argumentsKey = hasArgs
      ? await this.storeApprovalArguments({
          toolName: options.toolName,
          args: options.toolArgs ?? {},
        })
      : null;
    const subject = options.reviewText
      ? // The review text may carry column-aligned art; keep it monospace.
        `\`\`\`\n${formatApprovalReviewText(options.reviewText)}\n\`\`\``
      : `\`${options.toolName}\``;
    const postArgs = {
      channel: options.channelId,
      text: "",
      blocks: [
        {
          type: "section" as const,
          text: {
            type: "mrkdwn" as const,
            text: `*Approval required*\n${subject}\nReview this tool call before it can continue.`,
          },
        },
        {
          type: "actions" as const,
          elements: [
            generateButton("Approve", "primary", true, "approve"),
            generateButton("Deny", "danger", false, "decline"),
            ...(argumentsKey
              ? [
                  {
                    type: "button" as const,
                    text: {
                      type: "plain_text" as const,
                      text: "View arguments",
                      emoji: true,
                    },
                    action_id: `${VIEW_ARGUMENTS_ACTION_PREFIX}${options.approvalId}`,
                    value: argumentsKey,
                  },
                ]
              : []),
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

  /** Authenticate only the outbound sender; never open a socket or change the app. */
  async verifyRuntimeNoticeWorkspace(workspaceId: string): Promise<void> {
    const identity = await this.runtimeNoticeClient().auth.test();
    if (identity.team_id !== workspaceId || !identity.bot_id) {
      throw new Error("Slack runtime notice workspace mismatch");
    }
    this.botId = identity.bot_id;
  }

  /** Prepare outbound thread delivery without configuring the app or opening inbound listeners. */
  async initializeOutbound(workspaceId: string): Promise<void> {
    if (this.client && this.teamId === workspaceId) return;
    const client = this.runtimeNoticeClient();
    const identity = await client.auth.test();
    if (identity.team_id !== workspaceId || !identity.bot_id)
      throw new Error("Slack outbound workspace mismatch");
    this.botId = identity.bot_id;
    this.botUserId = identity.user_id ?? null;
    this.teamId = workspaceId;
    this.client = client;
    this.bestEffortClient = client;
  }

  /** Generic runtime attention only: no command, prompt, or approval payload. */
  async postRuntimeAttentionNotice(params: {
    channelId: string;
    threadId: string;
    noticeId: string;
    runUrl: string;
  }): Promise<string> {
    const result = await this.runtimeNoticeClient().chat.postMessage({
      channel: params.channelId,
      thread_ts: params.threadId,
      ...runtimeAttentionContent(params.runUrl, false),
      metadata: {
        event_type: "archestra_runtime_attention",
        event_payload: { notice_id: params.noticeId },
      },
      unfurl_links: false,
      unfurl_media: false,
      reply_broadcast: false,
    });
    if (!result.ts)
      throw new Error("Slack runtime notice returned no message timestamp");
    return result.ts;
  }

  async resolveRuntimeAttentionNotice(params: {
    channelId: string;
    messageTs: string;
    runUrl: string;
  }): Promise<void> {
    await this.runtimeNoticeClient().chat.update({
      channel: params.channelId,
      ts: params.messageTs,
      ...runtimeAttentionContent(params.runUrl, true),
    });
  }

  /** Recover an uncertain post without blindly creating a second notification. */
  async findRuntimeAttentionNotice(params: {
    channelId: string;
    threadId: string;
    noticeId: string;
  }): Promise<string | null> {
    const client = this.runtimeNoticeClient();
    let cursor: string | undefined;
    // Bounded below the delivery lease. If a very long thread cannot be fully
    // checked, fail safely instead of posting a possible duplicate.
    for (let page = 0; page < 10; page++) {
      const result = await client.conversations.replies({
        channel: params.channelId,
        ts: params.threadId,
        cursor,
        limit: 100,
        include_all_metadata: true,
      });
      const message = result.messages?.find(
        (message) =>
          message.bot_id === this.botId &&
          message.metadata?.event_type === "archestra_runtime_attention" &&
          (
            message.metadata?.event_payload as
              | Record<string, unknown>
              | undefined
          )?.notice_id === params.noticeId,
      );
      if (message?.ts) return message.ts;
      cursor = result.response_metadata?.next_cursor || undefined;
      if (!cursor && !result.has_more) return null;
      if (!cursor) break;
    }
    throw new Error(
      "Could not finish checking the Slack thread for a runtime notice",
    );
  }

  async updateApprovalRequest(
    options: UpdateApprovalRequestOptions,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("SlackProvider not initialized");
    }
    const status = options.approved
      ? ":white_check_mark: Approved"
      : ":x: Denied";
    const text = options.decidedByUserId
      ? `\`${options.toolName}\`: ${status} by <@${options.decidedByUserId}>`
      : `\`${options.toolName}\`: ${status}`;
    await this.client.chat.update({
      channel: options.channelId,
      ts: options.messageKey,
      text,
      // Replacing the blocks removes the buttons, so no one clicks twice.
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
    });
    if (options.pausedToolCall) {
      await updatePausedTasks({
        client: this.client,
        channelId: options.channelId,
        threadTs: options.pausedToolCall.threadId,
        taskIds: [options.pausedToolCall.toolCallId],
        outcome: options.approved ? "approved" : "declined",
      });
    }
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
          // Slack rejects the whole card past 100 options or 75-char labels.
          options: params.agents
            .slice(0, SLACK_SELECT_MAX_OPTIONS)
            .map((agent) => ({
              text: {
                type: "plain_text" as const,
                text: truncateSlackOptionText(agent.name),
              },
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
              text: `*Tip:* You can use other agents with the syntax *AgentName >* (e.g., @${archestraMcpBranding.appName} Sales > what's the status?).`,
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
                `\`${SLACK_SLASH_COMMANDS.HELP}\` — Show available commands\n\n` +
                "Reply `mute` or react :mute: to stop auto-replies in a thread. Mention me again to resume auto-replies. Press *Stop* to cancel only the current answer.",
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
      ? `Welcome to ${archestraMcpBranding.appName}!`
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
      const trimmedMessages = allMessages.slice(0, limit).map((message) => ({
        ...message,
        text: slackThreadMessageText(message),
      }));

      // Keep text-less USER messages that carry downloadable files: a
      // screenshot posted alone is a turn the model must know about — its
      // file is either delivered or surfaced as skipped by the manager. Bot
      // file-only messages stay filtered: the manager never downloads bot
      // files, so retaining them would render a turn with no file and no
      // skip note.
      const filtered = trimmedMessages.filter(
        (msg) =>
          msg.ts &&
          msg.ts !== params.excludeMessageId &&
          (msg.text ||
            (!msg.bot_id &&
              msg.user !== this.botUserId &&
              (msg.files as SlackFile[] | undefined)?.some(
                (f) => f.url_private_download || f.url_private,
              ))),
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

        // Only this bot's own messages are its side of the conversation.
        // Another bot in the thread (a sibling agent, an integration) speaks
        // under its own name, like a person.
        const isFromBot = this.botId
          ? msg.bot_id === this.botId || msg.user === this.botUserId
          : Boolean(msg.bot_id) || msg.user === this.botUserId;
        const otherBot = msg as {
          bot_profile?: { name?: string };
          username?: string;
        };
        const otherBotName = otherBot.bot_profile?.name ?? otherBot.username;
        const senderName = isFromBot
          ? msg.user || "Unknown"
          : msg.bot_id
            ? otherBotName || msg.bot_id
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

  async getChannelDescription(channelId: string): Promise<string | null> {
    const client = this.bestEffortClient ?? this.client;
    if (!client) return null;
    const cached = this.channelDescriptionCache.get(channelId);
    if (cached !== undefined) return cached || null;
    try {
      const result = await client.conversations.info({
        channel: channelId,
      });
      const description = plainSlackText(
        (result.channel as { purpose?: { value?: string } } | undefined)
          ?.purpose?.value,
      );
      this.channelDescriptionCache.set(channelId, description);
      return description || null;
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), channelId },
        "[SlackProvider] Failed to get channel description",
      );
      // Answer without it for a minute rather than wait on Slack every reply.
      this.channelDescriptionCache.set(channelId, "", TimeInMs.Minute);
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
   * Channels this bot can be in: every public channel, marked with whether the
   * bot has joined, and the private channels it was invited to. Unlike
   * discoverChannels, a failure propagates so the caller can say Slack failed.
   */
  async listJoinableChannels(): Promise<SlackJoinableChannel[]> {
    if (!this.client) throw new Error("SlackProvider not initialized");
    const channels: SlackJoinableChannel[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 999,
        cursor,
      });
      for (const channel of result.channels ?? []) {
        if (!channel.id) continue;
        channels.push({
          channelId: channel.id,
          channelName: channel.name || null,
          description: plainSlackText(channel.purpose?.value) || null,
          isPrivate: channel.is_private === true,
          isMember: channel.is_member === true,
        });
      }
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return channels;
  }

  /** Add this bot to a public channel (needs the channels:join scope). */
  async joinChannel(
    channelId: string,
  ): Promise<{ channelName: string | null }> {
    if (!this.client) throw new Error("SlackProvider not initialized");
    const result = await this.client.conversations.join({ channel: channelId });
    return { channelName: result.channel?.name || null };
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

    // Send welcome DM (fire-and-forget) for newly provisioned users
    const welcomeMode =
      provisioned.invitationId !== null
        ? await resolveSignupWelcomeMode()
        : "none";
    if (provisioned.invitationId !== null && welcomeMode !== "none") {
      const welcome = await buildWelcomeMessage({
        mode: welcomeMode,
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
            `\`${slashCommands.HELP}\` — Show this help message\n\n` +
            "Reply `mute` or react :mute: to stop auto-replies in a thread. Mention me again to resume auto-replies. Press *Stop* to cancel only the current answer.\n\n" +
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
              `*Tip:* You can use other agents with the syntax *AgentName >* (e.g., @${archestraMcpBranding.appName} Sales > what's the status?).\n\n` +
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
        return null;
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

  /**
   * Put the thread's agent session into "processing": Slack shows a working
   * indicator with a Stop button (see handleSessionStopped).
   */
  async setTypingStatus(channelId: string, threadTs: string): Promise<void> {
    await this.setSessionStatus(channelId, threadTs, "processing");
  }

  /**
   * Move the session back to "active". Agent sessions stay "processing" until
   * told otherwise — posting a reply does not clear it — so every run ends
   * here, replied or silent.
   */
  async clearTypingStatus(channelId: string, threadTs: string): Promise<void> {
    await this.setSessionStatus(channelId, threadTs, "active");
  }

  async downloadFiles(
    files: ChatThreadMessageFile[],
  ): Promise<ThreadFileOutcome[]> {
    if (files.length === 0) return [];
    // Report every file as failed rather than silently returning nothing —
    // the positional contract promises one outcome per input file.
    if (!this.client) {
      return files.map((f) => ({
        status: "skipped",
        skipped: {
          name: f.name,
          sizeBytes: f.size,
          reason: "download_failed",
        },
      }));
    }
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

  /** Required bot scopes the token does not have (as of the last check). */
  getMissingScopes(): string[] {
    return [...this.missingScopes];
  }

  /**
   * Where an admin reinstalls this app to grant scopes it lacks: its OAuth &
   * Permissions page, with the Reinstall to Workspace button.
   */
  getReinstallUrl(): string {
    return this.config.appId
      ? `https://api.slack.com/apps/${this.config.appId}/oauth`
      : "https://api.slack.com/apps";
  }

  /**
   * Check the token's scopes again, so a reinstall shows up without a
   * restart. Non-fatal: on failure the last known state stays.
   */
  async refreshGrantedScopes(): Promise<void> {
    if (!this.config.botToken) return;
    try {
      const response = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.botToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      if ((await response.json()).ok) {
        this.parseGrantedScopes(response.headers.get("x-oauth-scopes"));
      }
    } catch (error) {
      logger.debug(
        { error: errorMessage(error) },
        "[SlackProvider] Could not re-check granted scopes",
      );
    }
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

    // Per app: several Slack apps (one per agent) can share a workspace.
    const cacheKey: AllowedCacheKey = `${CacheKey.SlackScopeNotification}-${this.teamId ?? "unknown"}-${this.config.appId || "main"}`;
    const alreadyNotified = await cacheManager.get<boolean>(cacheKey);
    if (alreadyNotified) return;

    const scopeList = this.missingScopes.map((s) => `  • \`${s}\``).join("\n");

    const appName = await OrganizationModel.getAppName();
    const text = [
      `:warning: *Reinstall this Slack app to finish setting it up*`,
      "",
      `${appName} needs permissions this app has not been granted yet:`,
      scopeList,
      "",
      "Until then, some features may not work.",
      "",
      `1. Open the app's <${this.getReinstallUrl()}|OAuth & Permissions page>`,
      "2. If a scope above is not listed under *Bot Token Scopes*, add it",
      "3. Click *Reinstall to Workspace* and approve",
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

  private runtimeNoticeClient(): WebClient {
    if (!this.isConfigured()) {
      throw new Error("Slack runtime notice provider not initialized");
    }
    // The durable task queue owns retries. Bound each call so it cannot outlive
    // the notice's delivery lease, including rate-limit responses.
    return new WebClient(this.config.botToken, {
      retryConfig: { retries: 0 },
      timeout: 10_000,
      rejectRateLimitedCalls: true,
    });
  }

  /** Completed control retries must not stop a later turn or re-mute a resumed thread. */
  private async handleControlEvent(
    body: SlackEventPayload,
    handle: () => Promise<void>,
  ): Promise<void> {
    const eventId = body.event_id;
    const key = eventId
      ? `slack-control:${this.stateScope ?? "main"}:${eventId}`
      : null;
    if (key && (await ChatOpsProcessedMessageModel.isProcessed(key))) return;
    await handle();
    if (key) await ChatOpsProcessedMessageModel.tryMarkAsProcessed(key);
  }

  /** Mute reactions are control events, never messages for the agent. */
  private async handleMuteReaction(event: SlackEvent): Promise<void> {
    if (
      event.item?.type !== "message" ||
      !isMuteReaction(event.reaction ?? "") ||
      event.user === this.botUserId ||
      isSlackDmChannel(event.item.channel)
    )
      return;

    const channelId = event.item.channel;
    const threadTs = await this.resolveMuteThreadRoot(channelId, event.item.ts);
    if (!threadTs) return;
    await muteChannelThread({
      provider: this.providerId,
      channelId,
      threadId: threadTs,
      scope: this.stateScope,
    });
    await this.setSessionStatus(channelId, threadTs, "active");
  }

  /** Reaction events carry the reacted message's ts, rather than its thread root. */
  private async resolveMuteThreadRoot(
    channelId: string,
    ts: string,
  ): Promise<string | null> {
    const activation = {
      provider: this.providerId,
      channelId,
      threadId: ts,
      scope: this.stateScope,
    };
    try {
      if (
        (await isChannelThreadActive(activation)) ||
        (await isChannelThreadMuted(activation))
      )
        return ts;
    } catch {
      // A cache failure falls through to Slack's lookup.
    }
    if (!this.client) return null;
    try {
      // conversations.replies requires a parent ts; reactions.get returns the
      // actual reacted message, including thread_ts when it is a reply.
      const result = await this.client.reactions.get({
        channel: channelId,
        timestamp: ts,
      });
      // Slack returns a message object, but this SDK's reaction-specific type
      // omits the thread timestamp field.
      const message = result.message as
        | (typeof result.message & { thread_ts?: string })
        | undefined;
      return message?.thread_ts || message?.ts || null;
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), channelId, ts },
        "[SlackProvider] Failed to resolve mute reaction thread",
      );
      return null;
    }
  }

  /** Stop cancels the current turn; only mute ends automatic follow-ups. */
  private async handleSessionStopped(event: SlackEvent): Promise<void> {
    const threadTs = event.thread_ts;
    if (!event.channel || !threadTs) return;
    logger.info(
      { channelId: event.channel, threadTs, userId: event.user },
      "[SlackProvider] Agent session stopped by user",
    );
    await stopChannelThreadReply({
      provider: this.providerId,
      channelId: event.channel,
      threadId: threadTs,
      scope: this.stateScope,
    });
    await this.setSessionStatus(event.channel, threadTs, "active");
  }

  /**
   * Offer the DM's agent's suggested prompts. In the Agent messaging
   * experience they sit at the top of the Messages tab (no thread); in the
   * legacy assistant experience they belong to the new assistant thread.
   * Nothing is offered until the DM has an agent, or when it has no prompts.
   * A bot pinned to an agent always offers that agent's prompts.
   */
  private async setSuggestedPrompts(params: {
    channelId: string;
    threadTs?: string;
    workspaceId: string | null;
  }): Promise<void> {
    if (!this.client) return;
    try {
      const agentId =
        this.pinnedAgentId ??
        (
          await ChatOpsChannelBindingModel.findByChannel({
            provider: this.providerId,
            channelId: params.channelId,
            workspaceId: params.workspaceId,
          })
        )?.agentId;
      if (!agentId) return;
      const agent = await AgentModel.findById(agentId);
      const prompts = (agent?.suggestedPrompts ?? [])
        .slice(0, SLACK_MAX_SUGGESTED_PROMPTS)
        .map((prompt) => ({
          title: prompt.summaryTitle,
          message: prompt.prompt,
        }));
      if (prompts.length === 0) return;

      // The Messages-tab list persists, so an unchanged one is not re-sent.
      const signature = JSON.stringify(prompts);
      if (
        !params.threadTs &&
        this.suggestedPromptsCache.get(params.channelId) === signature
      ) {
        return;
      }
      await this.client.assistant.threads.setSuggestedPrompts({
        channel_id: params.channelId,
        prompts,
        // thread_ts is legacy-only: an agent app's call silently fails with it.
        ...(params.threadTs && { thread_ts: params.threadTs }),
      } as Parameters<
        WebClient["assistant"]["threads"]["setSuggestedPrompts"]
      >[0]);
      if (!params.threadTs) {
        this.suggestedPromptsCache.set(params.channelId, signature);
      }
    } catch (error) {
      // Non-fatal: e.g. static prompts configured in the app settings.
      logger.debug(
        { error: errorMessage(error), channelId: params.channelId },
        "[SlackProvider] Failed to set suggested prompts (non-fatal)",
      );
    }
  }

  /**
   * Set the thread's agent session status. Apps still on the legacy assistant
   * experience reject agents.sessions.*, so they fall back to
   * assistant.threads.setStatus, which Slack bridges to the same session
   * (non-empty status = processing, empty = active).
   */
  private async setSessionStatus(
    channelId: string,
    threadTs: string,
    status: "processing" | "active",
  ): Promise<void> {
    if (!this.client || !threadTs) return;
    if (!this.useLegacyThreadStatus) {
      try {
        await this.client.apiCall("agents.sessions.setStatus", {
          channel_id: channelId,
          thread_ts: threadTs,
          status,
        });
        return;
      } catch (error) {
        if (isRateLimitError(error)) return;
        this.useLegacyThreadStatus = true;
        logger.debug(
          { error: errorMessage(error) },
          "[SlackProvider] agents.sessions.setStatus unavailable; using assistant.threads.setStatus",
        );
      }
    }
    try {
      await this.client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status: status === "processing" ? "is thinking..." : "",
      });
    } catch (error) {
      // Non-fatal: fails if the app isn't an agent/assistant or lacks the scope.
      logger.debug(
        { error: errorMessage(error) },
        "[SlackProvider] assistant.threads.setStatus failed (non-fatal)",
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

    // response_url (HTTP POST) works for ~30 min after the command.
    const postToResponseUrl = async (response: Record<string, unknown>) => {
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
          "[SlackProvider] Slash command response_url post failed",
        );
      }
    };

    // Slack shows "the app did not respond" unless the command is acked
    // within 3s. Looking up the user and agents and posting a card can take
    // longer, so past the deadline ack empty and send the reply by
    // response_url instead.
    let acked = false;
    const ackTimer = setTimeout(() => {
      acked = true;
      ack().catch((error) => {
        logger.warn(
          { error: errorMessage(error), command: cmd.command },
          "[SlackProvider] Slash command ack failed",
        );
      });
    }, SLASH_COMMAND_ACK_DEADLINE_MS);

    // Deliver the reply. Prefer ack() over the socket; if the socket is
    // mid-rotation the ack rejects, so fall back to response_url.
    const deliver = async (response?: Record<string, unknown>) => {
      clearTimeout(ackTimer);
      if (!acked) {
        acked = true;
        try {
          await ack(response);
          return;
        } catch (error) {
          logger.warn(
            { error: errorMessage(error), command: cmd.command },
            "[SlackProvider] Slash command ack failed; falling back to response_url",
          );
        }
      }
      // With no body, the ack only closes Slack's spinner; the side effect
      // (e.g. the agent card) already happened.
      if (response) await postToResponseUrl(response);
    };

    try {
      const response = await this.handleSlashCommand(cmd);
      await deliver(response ?? undefined);
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
            // Messages carry event.ts; other events (Stop, DM opened) carry
            // event.event_ts instead — fall back to it so they dedup too.
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
   *
   * Returns exactly one outcome per input file, positionally aligned with
   * `files` — delivered attachment or the reason it was dropped — so callers
   * can tell the model a file existed instead of denying it. Exception: when
   * the provider is uninitialized this returns `[]`; `downloadFiles` maps that
   * case for history callers, and the current-message path treats it as
   * "no attachments" exactly as before.
   */
  private async downloadSlackFiles(
    files?: SlackFile[],
  ): Promise<ThreadFileOutcome[]> {
    if (!files || files.length === 0 || !this.client) return [];

    const outcomes: ThreadFileOutcome[] = [];
    const skip = (skipped: SkippedAttachment): void => {
      outcomes.push({ status: "skipped", skipped });
    };
    let totalSize = 0;
    let deliveredCount = 0;
    // Once the combined budget is spent, every remaining file is recorded as
    // over-budget rather than silently skipped (the old code `break`-ed here).
    let budgetExhausted = false;

    for (const [index, file] of files.entries()) {
      // Anything past the per-message cap is dropped from processing; record
      // it rather than letting it vanish silently.
      if (index >= CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE) {
        skip({
          name: file.name,
          sizeBytes: file.size,
          reason: "too_many",
        });
        continue;
      }

      if (budgetExhausted) {
        skip({
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
        skip({
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
        skip({
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
        skip({
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
          skip({
            name: file.name,
            sizeBytes: file.size,
            reason: "download_failed",
          });
          continue;
        }

        // The download + shrink below is the memory-heavy section (response
        // buffer, native copy, decode allocation). Chatops messages are
        // processed fire-and-forget after the provider ack, so a burst of
        // attachment-heavy messages is only bounded by this per-process
        // semaphore.
        await slackFileTransferSemaphore.acquire();
        try {
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
            skip({
              name: file.name,
              sizeBytes: file.size,
              reason: "download_failed",
            });
            continue;
          }

          // Verify we got a file, not an HTML error/login page
          const responseContentType =
            response.headers.get("content-type") || "";
          if (responseContentType.includes("text/html")) {
            logger.warn(
              {
                fileId: file.id,
                fileName: file.name,
                contentType: responseContentType,
              },
              "[SlackProvider] Received HTML instead of file — bot may be missing files:read scope",
            );
            skip({
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
            skip({
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
            skip({
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
            buffer.length >
              CHATOPS_ATTACHMENT_LIMITS.MAX_MODEL_INLINE_IMAGE_SIZE
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
              skip({
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
            skip({
              name: file.name,
              sizeBytes: buffer.length,
              reason: "total_limit_reached",
            });
            budgetExhausted = true;
            continue;
          }

          totalSize += buffer.length;
          deliveredCount++;
          outcomes.push({
            status: "delivered",
            attachment: {
              contentType,
              contentBase64: buffer.toString("base64"),
              name: file.name,
            },
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
        } finally {
          slackFileTransferSemaphore.release();
        }
      } catch (error) {
        logger.warn(
          { fileId: file.id, fileName: file.name, error: errorMessage(error) },
          "[SlackProvider] Error downloading file",
        );
        skip({
          name: file.name,
          sizeBytes: file.size,
          reason: "download_failed",
        });
      }
    }

    if (deliveredCount > 0) {
      logger.info(
        {
          fileCount: deliveredCount,
          totalSize,
          originalFileCount: files.length,
        },
        "[SlackProvider] Downloaded file attachments from Slack message",
      );
    }

    return outcomes;
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

    // Reset either way: a reinstall that granted the scopes clears the warning.
    this.missingScopes = missing;
    if (missing.length > 0) {
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

  /** A user's Slack username (the @handle), or null when it can't be read. */
  private async fetchUserHandle(userId: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const result = await this.client.users.info({ user: userId });
      // Slack derives a bot's username from its name, cut to 21 characters
      // without separators; people see and @mention the bot's name. A bot user
      // usually leaves `display_name` empty and carries that name in
      // `real_name`.
      return (
        result.user?.profile?.display_name ||
        result.user?.profile?.real_name ||
        result.user?.real_name ||
        result.user?.name ||
        null
      );
    } catch (error) {
      logger.debug(
        { error: errorMessage(error), userId },
        "[SlackProvider] Could not read the bot's Slack handle",
      );
      return null;
    }
  }

  /**
   * A bot pinned to an agent already posts under that agent's name and icon,
   * so its replies drop the agent-name footer and keep only any extra detail.
   */
  private visibleFooter(footer: string | undefined): string | undefined {
    return this.pinnedAgentId ? footerWithoutAgentName(footer) : footer;
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

  /**
   * Parse a click on an approval's "View arguments" button. It is not a
   * decision: the button only opens the arguments in a modal.
   */
  private parseViewArgumentsPayload(
    payload: unknown,
  ): { argumentsKey: string; triggerId: string } | null {
    const p = payload as SlackInteractivePayload;
    if (p.type !== "block_actions" || !p.actions?.length) {
      return null;
    }
    const action = p.actions[0];
    if (
      !action.action_id?.startsWith(VIEW_ARGUMENTS_ACTION_PREFIX) ||
      !action.value ||
      !p.trigger_id
    ) {
      return null;
    }
    return { argumentsKey: action.value, triggerId: p.trigger_id };
  }

  /**
   * Keep an approval's arguments where its "View arguments" click can reach
   * them: a Slack button value is capped at 2,000 chars, so the button carries
   * only the key.
   */
  private async storeApprovalArguments(
    entry: SlackApprovalArguments,
  ): Promise<string> {
    const key = randomUUID();
    await cacheManager.set(
      approvalArgumentsCacheKey(key),
      entry,
      APPROVAL_ARGUMENTS_TTL_MS,
    );
    return key;
  }

  private async openApprovalArgumentsView(params: {
    argumentsKey: string;
    triggerId: string;
  }): Promise<void> {
    if (!this.client) {
      throw new Error("SlackProvider not initialized");
    }
    const entry = await cacheManager.get<SlackApprovalArguments>(
      approvalArgumentsCacheKey(params.argumentsKey),
    );
    const argsText = entry ? formatApprovalToolArgs(entry.args) : null;
    const blocks = entry
      ? [
          {
            type: "section" as const,
            text: { type: "mrkdwn" as const, text: `\`${entry.toolName}\`` },
          },
          {
            type: "section" as const,
            text: {
              type: "mrkdwn" as const,
              text: `\`\`\`\n${argsText ?? "{}"}\n\`\`\``,
            },
          },
        ]
      : [
          {
            type: "section" as const,
            text: {
              type: "mrkdwn" as const,
              text: "These arguments are no longer available.",
            },
          },
        ];
    try {
      await this.client.views.open({
        trigger_id: params.triggerId,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Arguments" },
          close: { type: "plain_text", text: "Close" },
          blocks,
        },
      });
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[SlackProvider] views.open (approval arguments) failed",
      );
    }
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

// assistant.threads.setSuggestedPrompts takes at most four prompts.
const SLACK_MAX_SUGGESTED_PROMPTS = 4;

/**
 * The context lines that close a reply: an even-more-subtle hint (e.g. the
 * session-rollover note) ABOVE the agent footer, so the footer stays the last
 * line of the reply.
 */
function buildTrailingContextBlocks(
  options: Pick<ChatReplyOptions, "hint" | "footer" | "conversationUrl">,
) {
  return [
    ...(options.conversationUrl
      ? [
          {
            type: "context" as const,
            elements: [
              {
                type: "mrkdwn" as const,
                text: `<${options.conversationUrl}|Open conversation>`,
              },
            ],
          },
        ]
      : []),
    ...[options.hint, options.footer]
      .filter((text): text is string => Boolean(text))
      .map((text) => ({
        type: "context" as const,
        elements: [{ type: "plain_text" as const, text, emoji: true }],
      })),
  ];
}

function isRateLimitError(error: unknown): boolean {
  return (
    (error as { code?: string } | null)?.code ===
    "slack_webapi_rate_limited_error"
  );
}

// Slack's chat.postMessage `text` is only a notification/accessibility fallback
// — the rendered reply lives in `blocks`. Slack rejects oversized payloads with
// `msg_too_large`, so cap the fallback well below Slack's ~40,000-char text
// limit instead of duplicating the full (already block-rendered) chunk into it.
// Slack allows 3s; leave room for the ack to travel back.
const SLASH_COMMAND_ACK_DEADLINE_MS = 2_000;

const SLACK_SELECT_MAX_OPTIONS = 100;
const SLACK_OPTION_TEXT_LIMIT = 75;

function truncateSlackOptionText(text: string): string {
  return text.length > SLACK_OPTION_TEXT_LIMIT
    ? `${text.slice(0, SLACK_OPTION_TEXT_LIMIT - 1)}…`
    : text;
}

const SLACK_FALLBACK_TEXT_LIMIT = 3_000;

function truncateFallbackText(text: string): string {
  if (text.length <= SLACK_FALLBACK_TEXT_LIMIT) return text;
  return `${text.slice(0, SLACK_FALLBACK_TEXT_LIMIT - 1)}…`;
}

// Slack rejects chat.postMessage with more than 50 expanded blocks. Each
// sendReply message reserves slots for context footers (a continuation hint, or
// the agent footer, an optional hint, and a conversation link — at most 3), so the
// markdown block's expansion is bounded to 45, keeping the worst case (45 + 3)
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
 * Per-process (deliberately not per provider instance) bound on concurrent
 * Slack file downloads + image shrinks — the memory-heavy section of
 * attachment processing. See config.chatops.maxConcurrentFileTransfers.
 */
const slackFileTransferSemaphore = new Semaphore(
  config.chatops.maxConcurrentFileTransfers,
);

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
  event_id?: string;
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
    blocks?: unknown[];
    reaction?: string;
    item?: { type?: string; channel: string; ts: string };
    // app_home_opened: which tab of the app's DM was opened
    tab?: string;
    // assistant_thread_started (legacy assistant experience)
    assistant_thread?: { channel_id: string; thread_ts: string };
  };
  challenge?: string;
}

type SlackEvent = NonNullable<SlackEventPayload["event"]>;

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
  trigger_id?: string;
}

/** The call an approval's "View arguments" modal shows. */
type SlackApprovalArguments = {
  toolName: string;
  args: Record<string, unknown>;
};

const VIEW_ARGUMENTS_ACTION_PREFIX = "approval_view_arguments_";

/** As long as an approval can wait for a decision. */
const APPROVAL_ARGUMENTS_TTL_MS = 7 * TimeInMs.Day;

function approvalArgumentsCacheKey(key: string): AllowedCacheKey {
  return `${CacheKey.SlackApprovalArguments}-${key}`;
}

/** Slack's markdown converter can absorb the next line into a bare URL. */
function protectSlackUrlBoundaries(text: string): string {
  // Leave fenced/inline code, explicit links and autolinks alone. Delimit bare
  // URLs before handing them to Slack's server-side Markdown converter.
  return text.replace(
    /(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`+[^`]*`+|<[^>\n]*>|\[[^\]\n]*\]\([^\n]*?\))|(https?:\/\/[^\s<>`]+)(?=[ \t]*\r?\n)/g,
    (match, protectedText: string | undefined, url: string | undefined) => {
      if (protectedText || !url) return match;
      const trailing = url.match(/[.,;:!?]+$/)?.[0] ?? "";
      const address = trailing ? url.slice(0, -trailing.length) : url;
      return `<${address}>${trailing}`;
    },
  );
}

/** A channel a bot pinned to an agent is in, or could join. */
/**
 * Slack's markup in a channel purpose as plain text: links (<url|label>,
 * <url>) and channel or user references (<#C1|name>) lose their brackets, and
 * escaped &, < and > are restored.
 *
 * @public — exported for slack-provider.test.ts
 */
export function plainSlackText(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/<#[A-Z0-9]+\|([^<>]+)>/g, "#$1")
    .replace(/<[^<>|]+\|([^<>]+)>/g, "$1")
    .replace(/<([^<>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

type SlackJoinableChannel = {
  channelId: string;
  channelName: string | null;
  /** The channel's purpose, as set in Slack. */
  description: string | null;
  isPrivate: boolean;
  isMember: boolean;
};

/** Only fixed copy and the ordinary authenticated app URL enter Slack. */
function runtimeAttentionContent(runUrl: string, resolved: boolean) {
  const text = resolved
    ? "Resolved — the runtime no longer needs your input."
    : "The runtime needs your input.";
  return {
    text: `${text} Open run: ${runUrl}`,
    blocks: [
      { type: "section" as const, text: { type: "plain_text" as const, text } },
      {
        type: "actions" as const,
        elements: [
          {
            type: "button" as const,
            action_id: "open_runtime_run",
            text: { type: "plain_text" as const, text: "Open run" },
            url: runUrl,
          },
        ],
      },
    ],
  };
}
