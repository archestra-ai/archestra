import { randomUUID } from "node:crypto";
import type { A2AAttachment } from "@/agents/a2a-executor";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { ChatOpsChannelBindingModel, OrganizationModel } from "@/models";
import type {
  AddApprovalRequestFormOptions,
  ChatOpsApprovalDecision,
  ChatOpsEventHandler,
  ChatOpsProvider,
  ChatOpsProviderType,
  ChatReplyOptions,
  ChatThreadMessage,
  ChatThreadMessageFile,
  DiscoveredChannel,
  IncomingChatMessage,
  SkippedAttachment,
  TelegramDbConfig,
  ThreadFileOutcome,
  ThreadHistoryParams,
  UpdateApprovalRequestOptions,
} from "@/types";
import {
  CHATOPS_ATTACHMENT_LIMITS,
  TELEGRAM_LINK_CODE_TTL_MS,
} from "./constants";
import { errorMessage, formatApprovalToolArgs } from "./utils";

/**
 * Telegram chatops provider.
 *
 * Deliberately minimal:
 * - Long polling only (getUpdates), like Slack's socket mode — no public URL,
 *   no webhook signature handling, no ngrok. The only credential is the bot
 *   token from @BotFather.
 * - Plain fetch against the Bot API — no SDK dependency.
 * - No new tables. Telegram exposes no user emails, so identity is a one-shot
 *   linking code that works in both directions: the signed-in web UI mints a
 *   code carried to the bot via a t.me ?start= deep link, or the bot's /start
 *   reply carries a code back to the web as a sign-in link. Either way the
 *   result is a fulfilled DM binding mapping the Telegram user ID to an
 *   email — and since a private chat ID equals the user ID, the same binding
 *   also authorizes the user in group chats.
 */
class TelegramProvider implements ChatOpsProvider {
  readonly providerId: ChatOpsProviderType = "telegram";
  readonly displayName = "Telegram";

  private config: TelegramDbConfig;
  private eventHandler: ChatOpsEventHandler | null = null;
  private botId: number | null = null;
  private botUsername: string | null = null;
  private pollAbort: AbortController | null = null;
  private pollDone: Promise<void> | null = null;

  constructor(telegramConfig: TelegramDbConfig) {
    this.config = telegramConfig;
  }

  isConfigured(): boolean {
    return Boolean(this.config.enabled && this.config.botToken);
  }

  setEventHandler(handler: ChatOpsEventHandler): void {
    this.eventHandler = handler;
  }

  getBotUsername(): string | null {
    return this.botUsername;
  }

  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info("[TelegramProvider] Not configured, skipping initialization");
      return;
    }

    const me = await this.callApi<TelegramUser>("getMe");
    this.botId = me.id;
    this.botUsername = me.username ?? null;
    logger.info(
      { botId: this.botId, botUsername: this.botUsername },
      "[TelegramProvider] Authenticated successfully",
    );

    // Long polling and webhooks are mutually exclusive in the Bot API; drop
    // any webhook a previous deployment may have registered.
    await this.callApi("deleteWebhook", { drop_pending_updates: false });

    this.pollAbort = new AbortController();
    this.pollDone = this.runPollingLoop(this.pollAbort.signal).catch(
      (error) => {
        logger.error(
          { error: errorMessage(error) },
          "[TelegramProvider] Polling loop terminated unexpectedly",
        );
      },
    );
  }

  async cleanup(): Promise<void> {
    this.pollAbort?.abort();
    await this.pollDone?.catch(() => {});
    this.pollAbort = null;
    this.pollDone = null;
    this.eventHandler = null;
    this.botId = null;
    this.botUsername = null;
    logger.info("[TelegramProvider] Cleaned up");
  }

  /** Long polling only — there is no webhook endpoint to validate. */
  async validateWebhookRequest(): Promise<boolean> {
    return false;
  }

  handleValidationChallenge(): unknown | null {
    return null;
  }

  async parseWebhookNotification(
    payload: unknown,
  ): Promise<IncomingChatMessage | null> {
    const message = (payload as TelegramUpdate | undefined)?.message;
    if (!message?.from || message.from.is_bot) return null;

    const chatType = message.chat.type;
    // Broadcast channels have no interactive senders; ignore them.
    if (
      chatType !== "private" &&
      chatType !== "group" &&
      chatType !== "supergroup"
    ) {
      return null;
    }
    const isGroup = chatType !== "private";

    const rawText = message.text ?? message.caption ?? "";
    const botMentioned = this.isBotMentioned(message);
    const isReplyToBot =
      message.reply_to_message?.from?.id != null &&
      message.reply_to_message.from.id === this.botId;

    // Groups: only act when addressed — mention, reply to the bot, or a
    // /command@thisbot. Telegram delivers every group /command to every bot,
    // so a bare unknown command may be meant for another bot and is ignored.
    if (
      isGroup &&
      !botMentioned &&
      !isReplyToBot &&
      !this.isCommandAddressedToBot(rawText)
    ) {
      return null;
    }

    let text = this.botUsername
      ? rawText.replaceAll(`@${this.botUsername}`, "").trim()
      : rawText.trim();

    // Bots cannot fetch chat history, so a reply to one of the bot's own
    // messages carries its quoted parent inline as single-turn context.
    const parentText = message.reply_to_message?.text;
    if (isReplyToBot && parentText) {
      text = `[In reply to your earlier message: "${truncate(parentText, 500)}"]\n\n${text}`;
    }

    const { attachments, skippedAttachments } =
      await this.downloadMessageAttachments(message);

    // Service messages, stickers, etc. — nothing for the agent to act on.
    if (
      !text.trim() &&
      attachments.length === 0 &&
      skippedAttachments.length === 0
    ) {
      return null;
    }

    return {
      messageId: `telegram:${message.chat.id}:${message.message_id}`,
      channelId: String(message.chat.id),
      workspaceId: null,
      threadId:
        message.is_topic_message && message.message_thread_id
          ? String(message.message_thread_id)
          : undefined,
      senderId: String(message.from.id),
      senderName: formatUserName(message.from),
      text,
      rawText,
      timestamp: new Date(message.date * 1000),
      isThreadReply: false,
      metadata: {
        ...(isGroup
          ? {
              conversationType: "groupChat",
              botMentioned: botMentioned || isReplyToBot,
              botName: this.botUsername,
            }
          : { channelType: "im", conversationType: "personal" }),
        telegramMessageId: message.message_id,
        ...(message.message_thread_id
          ? { messageThreadId: message.message_thread_id }
          : {}),
      },
      ...(attachments.length > 0 && { attachments }),
      ...(skippedAttachments.length > 0 && { skippedAttachments }),
    };
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    const { originalMessage } = options;
    let text = options.text;
    if (options.hint) text += `\n\n${options.hint}`;
    if (options.footer) text += `\n\n${options.footer}`;

    const metadata = originalMessage.metadata ?? {};
    const isGroup = metadata.conversationType === "groupChat";
    const replyToMessageId =
      isGroup && typeof metadata.telegramMessageId === "number"
        ? metadata.telegramMessageId
        : undefined;

    let firstId = "";
    for (const chunk of splitText(text, TELEGRAM_MESSAGE_CHUNK_SIZE)) {
      const id = await this.sendMessage({
        chatId: originalMessage.channelId,
        text: chunk,
        messageThreadId:
          typeof metadata.messageThreadId === "number"
            ? metadata.messageThreadId
            : undefined,
        replyToMessageId,
      });
      if (!firstId) firstId = id;
    }
    return firstId;
  }

  async addApprovalRequestForm(
    options: AddApprovalRequestFormOptions,
  ): Promise<void> {
    // Telegram caps callback_data at 64 bytes — far too small for the
    // approval payload — so the payload lives in the distributed cache and
    // the buttons carry only a random key.
    const key = randomUUID();
    const payload: TelegramApprovalCallbackPayload = {
      taskId: options.taskId,
      approvalId: options.approvalId,
      toolName: options.toolName,
      channelId: options.originalMessage.channelId,
      threadId: options.originalMessage.threadId,
      senderEmail: options.originalMessage.senderEmail,
      senderId: options.originalMessage.senderId,
      senderName: options.originalMessage.senderName,
      metadata: {
        ...(options.originalMessage.metadata?.conversationType === "groupChat"
          ? { conversationType: "groupChat" }
          : { channelType: "im", conversationType: "personal" }),
        telegramMessageId: options.originalMessage.metadata?.telegramMessageId,
        messageThreadId: options.originalMessage.metadata?.messageThreadId,
      },
    };
    await cacheManager.set(
      approvalCacheKey(key),
      payload,
      APPROVAL_CALLBACK_TTL_MS,
    );

    const argsText = formatApprovalToolArgs(options.toolArgs);
    const text = argsText
      ? `\`${options.toolName}\`\n\`\`\`\n${argsText}\n\`\`\``
      : `\`${options.toolName}\``;

    const metadata = options.originalMessage.metadata ?? {};
    await this.callApi("sendMessage", {
      chat_id: options.channelId,
      text: markdownToTelegramHtml(text),
      parse_mode: "HTML",
      ...(typeof metadata.messageThreadId === "number" && {
        message_thread_id: metadata.messageThreadId,
      }),
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `apr|${key}|a` },
            { text: "❌ Decline", callback_data: `apr|${key}|d` },
          ],
        ],
      },
    });
  }

  async updateApprovalRequest(
    options: UpdateApprovalRequestOptions,
  ): Promise<void> {
    const status = options.approved ? "✅ Approved" : "❌ Declined";
    // editMessageText without reply_markup also removes the buttons.
    await this.callApi("editMessageText", {
      chat_id: options.channelId,
      message_id: Number(options.messageKey),
      text: `${options.toolName}: ${status}`,
    });
  }

  async sendDirectMessage(params: {
    userId: string;
    text: string;
    actionUrl?: string;
    actionLabel?: string;
    channelId?: string;
  }): Promise<void> {
    // A Telegram DM chat ID equals the user ID, and bots can only message
    // users who already started a conversation — which linked users have.
    const text = params.actionUrl
      ? `${params.text}\n\n[${params.actionLabel ?? "Open"}](${params.actionUrl})`
      : params.text;
    await this.sendMessage({
      chatId: params.channelId ?? params.userId,
      text,
    });
  }

  async setTypingStatus(
    channelId: string,
    _threadTs: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    // Shows "typing…" for ~5s or until the bot sends a message.
    await this.callApi("sendChatAction", {
      chat_id: channelId,
      action: "typing",
      ...(typeof metadata?.messageThreadId === "number" && {
        message_thread_id: metadata.messageThreadId,
      }),
    });
  }

  /** Bots cannot read chat history in Telegram; context rides the message itself. */
  async getThreadHistory(
    _params: ThreadHistoryParams,
  ): Promise<ChatThreadMessage[]> {
    return [];
  }

  /**
   * Telegram exposes no emails. A user's email comes from their fulfilled DM
   * binding (created via the /start deep-link flow); since a private chat ID
   * equals the user ID, the same lookup authorizes group messages too.
   */
  async getUserEmail(userId: string): Promise<string | null> {
    const binding = await ChatOpsChannelBindingModel.findByChannel({
      provider: this.providerId,
      channelId: userId,
      workspaceId: null,
    });
    return binding?.isDm ? (binding.dmOwnerEmail ?? null) : null;
  }

  identityVerificationFailureText(): string {
    return "This Telegram account isn't linked to a user account yet. Send me /start in a direct message and I'll reply with a sign-in link to connect it.";
  }

  async getChannelName(channelId: string): Promise<string | null> {
    try {
      const chat = await this.callApi<TelegramChat>("getChat", {
        chat_id: channelId,
      });
      return chat.title ?? chat.username ?? null;
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[TelegramProvider] Failed to get chat name",
      );
      return null;
    }
  }

  parseInteractivePayload(payload: unknown): {
    agentId: string;
    channelId: string;
    workspaceId: string | null;
    threadTs?: string;
    userId: string;
    userName: string;
    responseUrl: string;
    isDm?: boolean;
  } | null {
    const cb = payload as TelegramCallbackQuery | undefined;
    const data = cb?.data;
    if (!cb?.message || !data?.startsWith(`${AGENT_SELECT_PREFIX}|`)) {
      return null;
    }
    return {
      agentId: data.slice(AGENT_SELECT_PREFIX.length + 1),
      channelId: String(cb.message.chat.id),
      workspaceId: null,
      threadTs: cb.message.message_thread_id
        ? String(cb.message.message_thread_id)
        : undefined,
      userId: String(cb.from.id),
      userName: formatUserName(cb.from),
      responseUrl: "",
      isDm: cb.message.chat.type === "private",
    };
  }

  async sendAgentSelectionCard(params: {
    message: IncomingChatMessage;
    agents: { id: string; name: string }[];
    isWelcome: boolean;
  }): Promise<void> {
    const metadata = params.message.metadata ?? {};
    await this.callApi("sendMessage", {
      chat_id: params.message.channelId,
      text: params.isWelcome
        ? "👋 Hi! Choose the agent for this conversation:"
        : "Choose an agent:",
      ...(typeof metadata.messageThreadId === "number" && {
        message_thread_id: metadata.messageThreadId,
      }),
      reply_markup: {
        inline_keyboard: params.agents
          .slice(0, MAX_SELECTION_AGENTS)
          .map((agent) => [
            {
              text: agent.name,
              callback_data: `${AGENT_SELECT_PREFIX}|${agent.id}`,
            },
          ]),
      },
    });
  }

  getWorkspaceId(): string | null {
    return null;
  }

  getWorkspaceName(): string | null {
    return null;
  }

  hasMissingScopes(): boolean {
    return false;
  }

  async notifyMissingScopes(): Promise<void> {
    // Telegram bots have no OAuth scopes.
  }

  async downloadFiles(
    files: ChatThreadMessageFile[],
  ): Promise<ThreadFileOutcome[]> {
    // Thread history is always empty for Telegram, so this is never called
    // with real files; report anything that does arrive as skipped.
    return files.map((file) => ({
      status: "skipped",
      skipped: {
        name: file.name,
        sizeBytes: file.size,
        reason: "download_failed",
      },
    }));
  }

  async discoverChannels(
    _context: unknown,
  ): Promise<DiscoveredChannel[] | null> {
    // The Bot API cannot list the chats a bot is in; bindings are created
    // when the first message from a chat arrives.
    return null;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async runPollingLoop(signal: AbortSignal): Promise<void> {
    let offset = 0;
    logger.info("[TelegramProvider] Starting long polling");
    while (!signal.aborted) {
      try {
        const updates = await this.callApi<TelegramUpdate[]>(
          "getUpdates",
          {
            offset,
            timeout: POLL_TIMEOUT_SECONDS,
            allowed_updates: ["message", "callback_query"],
          },
          signal,
        );
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          try {
            await this.handleUpdate(update);
          } catch (error) {
            logger.error(
              { error: errorMessage(error), updateId: update.update_id },
              "[TelegramProvider] Failed to handle update",
            );
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        // 409 means another consumer holds getUpdates (a second pod or a
        // leftover webhook) — back off harder to avoid a log storm.
        const conflict = errorMessage(error).includes("409");
        logger.warn(
          { error: errorMessage(error) },
          "[TelegramProvider] getUpdates failed, backing off",
        );
        await sleep(
          conflict ? POLL_CONFLICT_BACKOFF_MS : POLL_ERROR_BACKOFF_MS,
          signal,
        );
      }
    }
    logger.info("[TelegramProvider] Long polling stopped");
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.from || message.from.is_bot) return;
    if (await this.handleCommand(message)) return;
    await this.eventHandler?.handleIncomingMessage(this, update);
  }

  /**
   * Handle bot commands that must work before any agent is involved.
   * Returns true when the message was fully handled here.
   */
  private async handleCommand(message: TelegramMessage): Promise<boolean> {
    const text = (message.text ?? "").trim();
    if (!text.startsWith("/")) return false;

    const [rawCommand, ...args] = text.split(/\s+/);
    // Telegram appends the bot mention in groups: /command@botname
    const [command, mentionedBot] = rawCommand.split("@");
    if (mentionedBot && mentionedBot !== this.botUsername) return true;

    switch (command.toLowerCase()) {
      case "/start": {
        if (message.chat.type !== "private") return true;
        await this.sendMessage({
          chatId: String(message.chat.id),
          text: await this.linkAccount(message, args[0]),
        });
        return true;
      }
      case "/help": {
        await this.sendMessage({
          chatId: String(message.chat.id),
          text: HELP_TEXT,
          messageThreadId: message.message_thread_id,
        });
        return true;
      }
      case "/select-agent": {
        await this.handleSelectAgentCommand(message);
        return true;
      }
      default:
        // Unknown commands go to the agent like any other message.
        return false;
    }
  }

  /**
   * Link a Telegram account to a user, replying with what to do next.
   *
   * Two paths:
   * - Plain /start (the normal flow): mint a one-shot code and reply with a
   *   sign-in link. The user opens it, signs in as themselves, and the link
   *   endpoint ties this chat to their account — the email comes from their
   *   web session, so it can't be spoofed from Telegram.
   * - /start <bindingId> (t.me deep links from the admin channels table):
   *   fulfill that pending DM binding directly.
   */
  private async linkAccount(
    message: TelegramMessage,
    payload: string | undefined,
  ): Promise<string> {
    const chatId = String(message.chat.id);

    const existing = await ChatOpsChannelBindingModel.findByChannel({
      provider: this.providerId,
      channelId: chatId,
      workspaceId: null,
    });
    if (existing?.dmOwnerEmail) {
      return `✅ This Telegram account is already linked to ${existing.dmOwnerEmail}. Just send me a message!`;
    }

    if (!payload) {
      const code = randomUUID();
      await cacheManager.set(
        `${CacheKey.TelegramLinkCode}-${code}`,
        { chatId },
        TELEGRAM_LINK_CODE_TTL_MS,
      );
      return [
        "Let's link this Telegram account to your user account.",
        "",
        `Open ${config.frontendBaseUrl}/link-telegram?code=${code} and sign in — that's it.`,
        "",
        "The link is valid for 15 minutes. Send /start again for a fresh one.",
      ].join("\n");
    }
    if (!UUID_RE.test(payload)) {
      return "That linking code doesn't look valid. Send /start without a code to get a sign-in link.";
    }

    // A code minted by the signed-in web UI: it carries the user's email, and
    // this /start proves control of the Telegram chat — tie them together.
    const entry = await cacheManager.getAndDelete<{ email?: string }>(
      `${CacheKey.TelegramLinkCode}-${payload}`,
    );
    if (!entry?.email) {
      return "That linking code is invalid or expired. Send /start without a code to get a sign-in link.";
    }

    const existingDm = await ChatOpsChannelBindingModel.findDmBindingByEmail(
      this.providerId,
      entry.email,
    );
    if (existingDm) {
      await ChatOpsChannelBindingModel.fulfillDmBinding(
        existingDm.id,
        chatId,
        null,
      );
    } else {
      const org = await OrganizationModel.getFirst();
      if (!org)
        return "No organization is set up yet — contact your administrator.";
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: this.providerId,
        channelId: chatId,
        isDm: true,
        dmOwnerEmail: entry.email,
        channelName: `Direct Message - ${entry.email}`,
        agentId: null,
      });
    }
    logger.info(
      "[TelegramProvider] Linked Telegram account via t.me deep link",
    );
    return `✅ Linked as ${entry.email}. Just send me a message to start!`;
  }

  private async handleSelectAgentCommand(
    message: TelegramMessage,
  ): Promise<void> {
    if (!message.from || !this.eventHandler) return;
    const chatId = String(message.chat.id);
    const isDm = message.chat.type === "private";

    const senderEmail = await this.getUserEmail(String(message.from.id));
    if (!senderEmail) {
      await this.sendMessage({
        chatId,
        text: this.identityVerificationFailureText(),
        messageThreadId: message.message_thread_id,
      });
      return;
    }

    const agents = await this.eventHandler.getAccessibleChatopsAgents({
      senderEmail,
      isDm,
    });
    if (agents.length === 0) {
      await this.sendMessage({
        chatId,
        text: `No agents are available for you in ${this.displayName}. Contact your administrator.`,
        messageThreadId: message.message_thread_id,
      });
      return;
    }

    await this.sendAgentSelectionCard({
      message: {
        messageId: `telegram:${message.chat.id}:${message.message_id}`,
        channelId: chatId,
        workspaceId: null,
        senderId: String(message.from.id),
        senderEmail,
        senderName: formatUserName(message.from),
        text: "",
        rawText: "",
        timestamp: new Date(),
        isThreadReply: false,
        metadata: message.message_thread_id
          ? { messageThreadId: message.message_thread_id }
          : {},
      },
      agents,
      isWelcome: false,
    });
  }

  private async handleCallbackQuery(cb: TelegramCallbackQuery): Promise<void> {
    const data = cb.data ?? "";

    if (data.startsWith("apr|")) {
      await this.handleApprovalCallback(cb);
      return;
    }

    await this.answerCallbackQuery(cb.id);
    if (data.startsWith(`${AGENT_SELECT_PREFIX}|`)) {
      await this.eventHandler?.handleInteractiveSelection(this, cb);
    }
  }

  private async handleApprovalCallback(
    cb: TelegramCallbackQuery,
  ): Promise<void> {
    const [, key, action] = (cb.data ?? "").split("|");
    const cacheKey = approvalCacheKey(key);
    const payload =
      await cacheManager.get<TelegramApprovalCallbackPayload>(cacheKey);
    if (!payload) {
      await this.answerCallbackQuery(cb.id, "This approval request expired.");
      return;
    }

    // Only the requester may decide. The manager re-checks this, but checking
    // before consuming the one-shot payload keeps a stray click by another
    // group member from burning the approval.
    const approverEmail = await this.getUserEmail(String(cb.from.id));
    if (
      !approverEmail ||
      approverEmail.toLowerCase() !== payload.senderEmail?.toLowerCase()
    ) {
      await this.answerCallbackQuery(
        cb.id,
        "Only the person who asked for this action can decide.",
      );
      return;
    }

    await cacheManager.delete(cacheKey);
    await this.answerCallbackQuery(cb.id);

    const decision: ChatOpsApprovalDecision = {
      taskId: payload.taskId,
      approvalId: payload.approvalId,
      approved: action === "a",
      toolName: payload.toolName,
      messageTs: String(cb.message?.message_id ?? ""),
      channelId: payload.channelId,
      workspaceId: null,
      threadTs: payload.threadId,
      userId: String(cb.from.id),
      userName: formatUserName(cb.from),
      responseUrl: "",
      approverEmail,
      originalMessage: {
        messageId: `telegram-approval-${payload.approvalId}`,
        channelId: payload.channelId,
        workspaceId: null,
        threadId: payload.threadId,
        senderId: payload.senderId,
        senderEmail: payload.senderEmail,
        senderName: payload.senderName,
        text: "",
        rawText: "",
        timestamp: new Date(),
        isThreadReply: false,
        metadata: payload.metadata,
      },
    };
    await this.eventHandler?.handleInteractiveApprovalDecision(this, decision);
  }

  private async answerCallbackQuery(id: string, text?: string): Promise<void> {
    try {
      await this.callApi("answerCallbackQuery", {
        callback_query_id: id,
        ...(text && { text, show_alert: true }),
      });
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[TelegramProvider] Failed to answer callback query",
      );
    }
  }

  /**
   * Send one message, preferring HTML formatting (converted from the agent's
   * markdown) and falling back to plain text when Telegram rejects the markup.
   */
  private async sendMessage(params: {
    chatId: string;
    text: string;
    messageThreadId?: number;
    replyToMessageId?: number;
  }): Promise<string> {
    const base = {
      chat_id: params.chatId,
      ...(params.messageThreadId != null && {
        message_thread_id: params.messageThreadId,
      }),
      ...(params.replyToMessageId != null && {
        reply_parameters: {
          message_id: params.replyToMessageId,
          allow_sending_without_reply: true,
        },
      }),
      link_preview_options: { is_disabled: true },
    };
    try {
      const result = await this.callApi<TelegramMessage>("sendMessage", {
        ...base,
        text: markdownToTelegramHtml(params.text),
        parse_mode: "HTML",
      });
      return String(result.message_id);
    } catch {
      const result = await this.callApi<TelegramMessage>("sendMessage", {
        ...base,
        text: params.text,
      });
      return String(result.message_id);
    }
  }

  private isCommandAddressedToBot(text: string): boolean {
    if (!this.botUsername) return false;
    const match = /^\/\w+@(\w+)/.exec(text);
    return match?.[1]?.toLowerCase() === this.botUsername.toLowerCase();
  }

  private isBotMentioned(message: TelegramMessage): boolean {
    if (!this.botUsername) return false;
    const text = message.text ?? message.caption ?? "";
    const entities = message.entities ?? message.caption_entities ?? [];
    const mention = `@${this.botUsername.toLowerCase()}`;
    return entities.some(
      (entity) =>
        entity.type === "mention" &&
        text
          .slice(entity.offset, entity.offset + entity.length)
          .toLowerCase() === mention,
    );
  }

  private async downloadMessageAttachments(message: TelegramMessage): Promise<{
    attachments: A2AAttachment[];
    skippedAttachments: SkippedAttachment[];
  }> {
    const attachments: A2AAttachment[] = [];
    const skippedAttachments: SkippedAttachment[] = [];

    // Telegram provides several sizes per photo; take the largest that fits.
    const photo = message.photo
      ?.filter(
        (size) =>
          (size.file_size ?? 0) <=
          CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE,
      )
      .at(-1);
    if (message.photo && !photo) {
      skippedAttachments.push({
        name: "photo.jpg",
        sizeBytes: message.photo.at(-1)?.file_size,
        reason: "too_large",
      });
    }

    const files: { fileId: string; name: string; contentType: string }[] = [];
    if (photo) {
      files.push({
        fileId: photo.file_id,
        name: "photo.jpg",
        contentType: "image/jpeg",
      });
    }
    if (message.document) {
      const { document } = message;
      if (
        (document.file_size ?? 0) >
        CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE
      ) {
        skippedAttachments.push({
          name: document.file_name,
          sizeBytes: document.file_size,
          reason: "too_large",
        });
      } else {
        files.push({
          fileId: document.file_id,
          name: document.file_name ?? "document",
          contentType: document.mime_type ?? "application/octet-stream",
        });
      }
    }

    for (const file of files) {
      try {
        const info = await this.callApi<{ file_path?: string }>("getFile", {
          file_id: file.fileId,
        });
        if (!info.file_path) throw new Error("getFile returned no file_path");
        const response = await fetch(
          `${TELEGRAM_API_BASE}/file/bot${this.config.botToken}/${info.file_path}`,
        );
        if (!response.ok) {
          throw new Error(
            `file download failed with status ${response.status}`,
          );
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE) {
          skippedAttachments.push({
            name: file.name,
            sizeBytes: buffer.length,
            reason: "too_large",
          });
          continue;
        }
        attachments.push({
          contentType: file.contentType,
          contentBase64: buffer.toString("base64"),
          name: file.name,
        });
      } catch (error) {
        logger.warn(
          { error: errorMessage(error), name: file.name },
          "[TelegramProvider] Failed to download attachment",
        );
        skippedAttachments.push({ name: file.name, reason: "download_failed" });
      }
    }

    return { attachments, skippedAttachments };
  }

  /**
   * Call a Bot API method. Never log the request URL — it embeds the bot token.
   */
  private async callApi<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(
      `${TELEGRAM_API_BASE}/bot${this.config.botToken}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(params && { body: JSON.stringify(params) }),
        ...(signal && { signal }),
      },
    );
    const body = (await response.json()) as {
      ok: boolean;
      result?: T;
      error_code?: number;
      description?: string;
    };
    if (!body.ok) {
      throw new Error(
        `Telegram ${method} failed: ${body.error_code ?? response.status} ${body.description ?? ""}`.trim(),
      );
    }
    return body.result as T;
  }
}

export default TelegramProvider;

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Convert the agent's markdown to Telegram HTML (the parse mode with the
 * fewest escaping pitfalls). Everything is HTML-escaped first, then a small
 * set of markdown constructs is rewritten; anything unrecognized stays
 * visible as plain text. The caller falls back to plain text if Telegram
 * still rejects the markup.
 * @public — exported for testability
 */
export function markdownToTelegramHtml(markdown: string): string {
  const blocks: string[] = [];
  // A per-call random token means placeholders cannot collide with user text.
  const token = randomUUID();
  const placeholder = (index: number): string => `«${token}:${index}»`;
  // Pull code out first so its content is never formatted, only escaped.
  let text = markdown.replace(
    /```[^\n`]*\n?([\s\S]*?)```/g,
    (_, code: string) => {
      blocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`);
      return placeholder(blocks.length - 1);
    },
  );
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    blocks.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder(blocks.length - 1);
  });

  text = escapeHtml(text);
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2">$1</a>',
  );
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/(^|\s)_([^_\n]+)_(?=[\s.,!?;:]|$)/gm, "$1<i>$2</i>");
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  for (let i = 0; i < blocks.length; i++) {
    text = text.replace(placeholder(i), blocks[i]);
  }
  return text;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Split text into chunks below Telegram's 4096-char message cap, preferring newlines. */
function splitText(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > chunkSize) {
    const window = rest.slice(0, chunkSize);
    const breakAt = window.lastIndexOf("\n");
    const cut = breakAt > chunkSize / 2 ? breakAt : chunkSize;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function formatUserName(user: TelegramUser): string {
  return (
    [user.first_name, user.last_name].filter(Boolean).join(" ") ||
    user.username ||
    String(user.id)
  );
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function approvalCacheKey(key: string): AllowedCacheKey {
  return `${CacheKey.TelegramApprovalCallback}-${key}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

const TELEGRAM_API_BASE = "https://api.telegram.org";
/** Raw-markdown budget per message, leaving room for HTML tags under the 4096 cap. */
const TELEGRAM_MESSAGE_CHUNK_SIZE = 3500;
const POLL_TIMEOUT_SECONDS = 25;
const POLL_ERROR_BACKOFF_MS = 5_000;
const POLL_CONFLICT_BACKOFF_MS = 30_000;
/** How long approval buttons stay clickable. */
const APPROVAL_CALLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_SELECT_PREFIX = "agent_select";
const MAX_SELECTION_AGENTS = 25;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HELP_TEXT = [
  "Here's what I can do:",
  "",
  "• Send me a message and I'll pass it to your assigned agent.",
  "• /select-agent — choose which agent answers in this chat.",
  "• AgentName > message — route one message to a different agent.",
  "• /start — link your Telegram account (DM only).",
].join("\n");

// Minimal Telegram Bot API shapes — only the fields this provider reads.
// https://core.telegram.org/bots/api

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
}

interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  message_thread_id?: number;
  is_topic_message?: boolean;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** Payload behind an approval button's 64-byte callback_data, stored in the distributed cache. */
interface TelegramApprovalCallbackPayload {
  taskId: string;
  approvalId: string;
  toolName: string;
  channelId: string;
  threadId?: string;
  senderEmail?: string;
  senderId: string;
  senderName: string;
  metadata: Record<string, unknown>;
}
