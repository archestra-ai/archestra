import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { ChatOpsChannelBindingModel, OrganizationModel } from "@/models";
import type {
  A2AAttachment,
  AddApprovalRequestFormOptions,
  ChatOpsEventHandler,
  ChatOpsProvider,
  ChatOpsProviderType,
  ChatReplyOptions,
  ChatThreadMessage,
  ChatThreadMessageFile,
  DiscoveredChannel,
  IncomingChatMessage,
  SkippedAttachment,
  ThreadFileOutcome,
  ThreadHistoryParams,
  UpdateApprovalRequestOptions,
  WhatsAppDbConfig,
} from "@/types";
import {
  CHATOPS_ATTACHMENT_LIMITS,
  CHATOPS_COMMANDS,
  WHATSAPP_LINK_CODE_TTL_MS,
} from "./constants";
import {
  buildAgentFooter,
  errorMessage,
  isSessionResetCommand,
  stripDuplicateAgentFooter,
} from "./utils";

/**
 * WhatsApp Cloud API chatops provider.
 *
 * Uses Meta's Graph API directly over fetch with no external SDK dependency:
 * - Webhook GET challenge verification via `hub.verify_token`
 * - Webhook POST authenticity via HMAC-SHA256 (`X-Hub-Signature-256`)
 * - Server-side conversation sessions (`usesServerSideSessions = true`)
 * - Bidirectional one-shot account linking (`/start` and `wa.me` deep links)
 * - Native interactive reply buttons and list pickers for tool approvals and agent selection
 */
class WhatsAppProvider implements ChatOpsProvider {
  readonly providerId: ChatOpsProviderType = "whatsapp";
  readonly displayName = "WhatsApp";
  readonly usesServerSideSessions = true;

  private config: WhatsAppDbConfig;
  private eventHandler: ChatOpsEventHandler | null = null;
  private resolvedDisplayPhoneNumber: string | null = null;
  private verifiedName: string | null = null;

  constructor(whatsAppConfig: WhatsAppDbConfig) {
    this.config = whatsAppConfig;
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.enabled &&
        this.config.accessToken &&
        this.config.phoneNumberId &&
        this.config.appSecret &&
        this.config.verifyToken,
    );
  }

  setEventHandler(handler: ChatOpsEventHandler): void {
    this.eventHandler = handler;
  }

  getDisplayPhoneNumber(): string | null {
    const raw =
      this.resolvedDisplayPhoneNumber ?? this.config.displayPhoneNumber ?? "";
    const digits = normalizePhoneDigits(raw);
    return digits || null;
  }

  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info("[WhatsAppProvider] Not configured, skipping initialization");
      return;
    }

    const info = await this.fetchPhoneNumberMetadata();
    this.resolvedDisplayPhoneNumber = info.display_phone_number ?? null;
    this.verifiedName = info.verified_name ?? null;
    logger.info(
      {
        phoneNumberId: this.config.phoneNumberId,
        verifiedName: this.verifiedName,
      },
      "[WhatsAppProvider] Authenticated successfully",
    );
  }

  async cleanup(): Promise<void> {
    this.eventHandler = null;
    this.resolvedDisplayPhoneNumber = null;
    this.verifiedName = null;
    logger.info("[WhatsAppProvider] Cleaned up");
  }

  async validateWebhookRequest(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    if (!this.config.appSecret) return false;
    const rawPayload = typeof payload === "string" ? payload : null;
    if (rawPayload === null) return false;

    const headerVal =
      headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"];
    const signatureHeader = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
      return false;
    }

    const receivedHex = signatureHeader.slice("sha256=".length);
    if (!/^[0-9a-f]{64}$/i.test(receivedHex)) {
      return false;
    }

    const expectedHex = createHmac("sha256", this.config.appSecret)
      .update(rawPayload, "utf8")
      .digest("hex");

    return constantTimeEqual(
      receivedHex.toLowerCase(),
      expectedHex.toLowerCase(),
    );
  }

  handleValidationChallenge(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const query = payload as Record<string, unknown>;
    const mode = query["hub.mode"];
    const verifyToken = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    if (
      mode !== "subscribe" ||
      typeof verifyToken !== "string" ||
      typeof challenge !== "string"
    ) {
      return null;
    }

    if (
      !this.config.verifyToken ||
      !constantTimeEqual(verifyToken, this.config.verifyToken)
    ) {
      return null;
    }

    return challenge;
  }

  /**
   * Process a verified Meta Cloud API webhook payload, routing commands,
   * interactive replies, and standard messages to the ChatOps manager.
   */
  async handleWebhookPayload(
    payload: unknown,
    dedup?: { mark(key: string): boolean },
  ): Promise<void> {
    if (!this.eventHandler) return;
    const body = payload as WhatsAppWebhookPayload | undefined;
    if (body?.object !== "whatsapp_business_account" || !body.entry) return;

    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages" || !change.value) continue;
        const value = change.value;
        if (
          value.metadata?.phone_number_id &&
          value.metadata.phone_number_id !== this.config.phoneNumberId
        ) {
          continue;
        }

        const contactsByWaId = new Map<string, string>();
        for (const contact of value.contacts ?? []) {
          if (contact.wa_id && contact.profile?.name) {
            contactsByWaId.set(contact.wa_id, contact.profile.name);
          }
        }

        for (const message of value.messages ?? []) {
          if (!message.id || !message.from) continue;
          if (dedup?.mark(message.id)) continue;

          const senderName =
            contactsByWaId.get(message.from) ?? `+${message.from}`;

          if (await this.handleInteractiveMessage(message, senderName)) {
            continue;
          }

          if (await this.handleCommand(message, senderName)) {
            continue;
          }

          const singleEnvelope: WhatsAppSingleMessageEnvelope = {
            __whatsappSingleMessage: true,
            message,
            senderName,
            phoneNumberId:
              value.metadata?.phone_number_id ?? this.config.phoneNumberId,
          };
          await this.eventHandler.handleIncomingMessage(this, singleEnvelope);
        }
      }
    }
  }

  async parseWebhookNotification(
    payload: unknown,
  ): Promise<IncomingChatMessage | null> {
    const extracted = this.extractMessageFromPayload(payload);
    if (!extracted) return null;

    const { message, senderName, phoneNumberId } = extracted;
    if (phoneNumberId && phoneNumberId !== this.config.phoneNumberId) {
      return null;
    }

    const rawText = extractMessageText(message);
    let text = rawText.trim();

    if (isSessionResetCommand(text)) {
      return {
        messageId: `whatsapp:${message.from}:${message.id}`,
        channelId: message.from,
        workspaceId: null,
        senderId: message.from,
        senderName,
        text,
        rawText,
        timestamp: parseWhatsAppTimestamp(message.timestamp),
        isThreadReply: false,
        metadata: {
          channelType: "im",
          conversationType: "personal",
          whatsappMessageId: message.id,
        },
      };
    }

    const { attachments, skippedAttachments } =
      await this.downloadMessageAttachments(message);

    if (!text && attachments.length === 0 && skippedAttachments.length === 0) {
      return null;
    }

    if (message.context?.id) {
      text = `[Replying to message ${message.context.id}]\n\n${text}`.trim();
    }

    return {
      messageId: `whatsapp:${message.from}:${message.id}`,
      channelId: message.from,
      workspaceId: null,
      senderId: message.from,
      senderName,
      text,
      rawText,
      timestamp: parseWhatsAppTimestamp(message.timestamp),
      isThreadReply: Boolean(message.context?.id),
      ...(attachments.length > 0 && { attachments }),
      ...(skippedAttachments.length > 0 && { skippedAttachments }),
      metadata: {
        channelType: "im",
        conversationType: "personal",
        whatsappMessageId: message.id,
      },
    };
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    const metadata = options.originalMessage.metadata ?? {};
    const bodyText = stripDuplicateAgentFooter(options.text, options.footer);
    const footerText = buildAgentFooter(options.footer);
    const fullText = [
      bodyText + (footerText ? `\n\n_${footerText}_` : ""),
      options.hint ? `_${options.hint}_` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const replyToMessageId =
      options.replyInThread && typeof metadata.whatsappMessageId === "string"
        ? metadata.whatsappMessageId
        : undefined;

    let firstMessageId = "";
    const chunks = splitText(fullText, WHATSAPP_MESSAGE_CHUNK_SIZE);
    for (let i = 0; i < chunks.length; i++) {
      const id = await this.sendTextMessage({
        to: options.originalMessage.channelId,
        body: chunks[i],
        replyToMessageId: i === 0 ? replyToMessageId : undefined,
      });
      if (!firstMessageId) firstMessageId = id;
    }
    return firstMessageId;
  }

  async addApprovalRequestForm(
    options: AddApprovalRequestFormOptions,
  ): Promise<void> {
    const key = randomUUID();
    const payload: WhatsAppApprovalCallbackPayload = {
      taskId: options.taskId,
      approvalId: options.approvalId,
      toolName: options.toolName,
      channelId: options.originalMessage.channelId,
      threadId: options.threadId,
      senderEmail: options.senderEmail,
      senderId: options.originalMessage.senderId,
      senderName: options.originalMessage.senderName,
      metadata: {
        channelType: options.originalMessage.metadata?.channelType,
        conversationType: options.originalMessage.metadata?.conversationType,
      },
    };
    await cacheManager.set(
      approvalCacheKey(key),
      payload,
      APPROVAL_CALLBACK_TTL_MS,
    );

    const bodyText = formatApprovalPromptBody({
      toolName: options.toolName,
      toolArgs: options.toolArgs,
      explanation: options.explanation,
    });

    await this.callMessagesApi({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: options.originalMessage.channelId,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: [
            {
              type: "reply",
              reply: { id: `apr|${key}|a`, title: "Approve" },
            },
            {
              type: "reply",
              reply: { id: `apr|${key}|d`, title: "Deny" },
            },
          ],
        },
      },
    });
  }

  async updateApprovalRequest(
    options: UpdateApprovalRequestOptions,
  ): Promise<void> {
    const icon = options.status === "approved" ? "✅" : "❌";
    const word = options.status === "approved" ? "Approved" : "Denied";
    const by = options.reviewerName ? ` by ${options.reviewerName}` : "";
    const reason = options.reason ? `: ${options.reason}` : "";
    await this.sendTextMessage({
      to: options.channelId,
      body: `${icon} *${word}* (\`${options.toolName}\`)${by}${reason}`,
    });
  }

  async sendDirectMessage(params: {
    userId: string;
    text: string;
    actionUrl?: string;
    actionLabel?: string;
    channelId?: string;
  }): Promise<void> {
    const target = params.channelId ?? params.userId;
    const suffix =
      params.actionUrl && params.actionLabel
        ? `\n\n${params.actionLabel}: ${params.actionUrl}`
        : params.actionUrl
          ? `\n\n${params.actionUrl}`
          : "";
    await this.sendTextMessage({
      to: target,
      body: `${params.text}${suffix}`,
    });
  }

  async sendEphemeralMessage(params: {
    channelId: string;
    userId: string;
    text: string;
  }): Promise<void> {
    await this.sendTextMessage({
      to: params.channelId,
      body: params.text,
    });
  }

  async setTypingStatus(
    _channelId: string,
    _threadTs: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const messageId = metadata?.whatsappMessageId;
    if (typeof messageId !== "string" || !messageId) return;
    try {
      await this.callMessagesApi({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      });
    } catch (error) {
      logger.debug(
        { error: errorMessage(error) },
        "[WhatsAppProvider] Failed to send read receipt",
      );
    }
  }

  async getThreadHistory(
    _params: ThreadHistoryParams,
  ): Promise<ChatThreadMessage[]> {
    return [];
  }

  async getUserEmail(userId: string): Promise<string | null> {
    const binding = await ChatOpsChannelBindingModel.findByChannel({
      provider: this.providerId,
      channelId: userId,
      workspaceId: null,
    });
    return binding?.isDm ? (binding.dmOwnerEmail ?? null) : null;
  }

  identityVerificationFailureText(): string {
    return "This WhatsApp number is not linked to a user account yet. Send /start in this chat to receive a sign-in link and connect your account.";
  }

  async getChannelName(channelId: string): Promise<string | null> {
    return `WhatsApp (+${normalizePhoneDigits(channelId) || channelId})`;
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
    const item = payload as WhatsAppInteractiveSelectionPayload | undefined;
    if (!item?.id?.startsWith(`${AGENT_SELECT_PREFIX}|`) || !item.from) {
      return null;
    }
    return {
      agentId: item.id.slice(AGENT_SELECT_PREFIX.length + 1),
      channelId: item.from,
      workspaceId: null,
      userId: item.from,
      userName: item.senderName || `+${item.from}`,
      responseUrl: "",
      isDm: true,
    };
  }

  async sendAgentSelectionCard(params: {
    message: IncomingChatMessage;
    agents: { id: string; name: string }[];
    isWelcome: boolean;
  }): Promise<void> {
    const promptText = params.isWelcome
      ? "Hi! Choose the agent for this WhatsApp conversation:"
      : "Choose an agent for this conversation:";
    const visibleAgents = params.agents.slice(0, MAX_LIST_AGENTS);

    if (visibleAgents.length === 0) {
      await this.sendTextMessage({
        to: params.message.channelId,
        body: "No accessible agents were found for your account.",
      });
      return;
    }

    if (visibleAgents.length <= MAX_BUTTON_AGENTS) {
      await this.callMessagesApi({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: params.message.channelId,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: promptText },
          action: {
            buttons: visibleAgents.map((agent) => ({
              type: "reply",
              reply: {
                id: `${AGENT_SELECT_PREFIX}|${agent.id}`,
                title: truncatePlain(agent.name, WHATSAPP_BUTTON_TITLE_LIMIT),
              },
            })),
          },
        },
      });
      return;
    }

    await this.callMessagesApi({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.message.channelId,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: promptText },
        action: {
          button: "Select agent",
          sections: [
            {
              title: "Available agents",
              rows: visibleAgents.map((agent) => ({
                id: `${AGENT_SELECT_PREFIX}|${agent.id}`,
                title: truncatePlain(agent.name, WHATSAPP_ROW_TITLE_LIMIT),
              })),
            },
          ],
        },
      },
    });
  }

  getWorkspaceId(): string | null {
    return null;
  }

  getWorkspaceName(): string | null {
    return this.verifiedName;
  }

  hasMissingScopes(): boolean {
    return false;
  }

  async notifyMissingScopes(_message: IncomingChatMessage): Promise<void> {
    // Meta Cloud API tokens do not expose dynamic OAuth scope drift headers here.
  }

  async downloadFiles(
    files: ChatThreadMessageFile[],
  ): Promise<ThreadFileOutcome[]> {
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
    return null;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private extractMessageFromPayload(payload: unknown): {
    message: WhatsAppInboundMessage;
    senderName: string;
    phoneNumberId?: string;
  } | null {
    if (!payload || typeof payload !== "object") return null;

    if (
      (payload as WhatsAppSingleMessageEnvelope).__whatsappSingleMessage ===
      true
    ) {
      const env = payload as WhatsAppSingleMessageEnvelope;
      return {
        message: env.message,
        senderName: env.senderName,
        phoneNumberId: env.phoneNumberId,
      };
    }

    const webhook = payload as WhatsAppWebhookPayload;
    if (webhook.object !== "whatsapp_business_account") return null;
    for (const entry of webhook.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages" || !change.value) continue;
        const firstMessage = change.value.messages?.[0];
        if (!firstMessage?.id || !firstMessage.from) continue;
        const contactName = change.value.contacts?.find(
          (c) => c.wa_id === firstMessage.from,
        )?.profile?.name;
        return {
          message: firstMessage,
          senderName: contactName ?? `+${firstMessage.from}`,
          phoneNumberId: change.value.metadata?.phone_number_id,
        };
      }
    }
    return null;
  }

  private async handleInteractiveMessage(
    message: WhatsAppInboundMessage,
    senderName: string,
  ): Promise<boolean> {
    if (message.type !== "interactive" || !message.interactive) return false;

    const replyId =
      message.interactive.button_reply?.id ??
      message.interactive.list_reply?.id;
    if (!replyId) return false;

    if (replyId.startsWith("apr|")) {
      await this.handleApprovalCallback(message.from, senderName, replyId);
      return true;
    }

    if (replyId.startsWith(`${AGENT_SELECT_PREFIX}|`)) {
      if (this.eventHandler) {
        const selectionPayload: WhatsAppInteractiveSelectionPayload = {
          id: replyId,
          from: message.from,
          senderName,
        };
        await this.eventHandler.handleInteractiveSelection(
          this,
          selectionPayload,
        );
      }
      return true;
    }

    return false;
  }

  private async handleApprovalCallback(
    senderId: string,
    senderName: string,
    replyId: string,
  ): Promise<void> {
    const [, key, action] = replyId.split("|");
    if (!key || (action !== "a" && action !== "d")) return;

    const cacheKey = approvalCacheKey(key);
    const payload =
      await cacheManager.get<WhatsAppApprovalCallbackPayload>(cacheKey);
    if (!payload) {
      await this.sendTextMessage({
        to: senderId,
        body: "This approval request has expired.",
      });
      return;
    }

    const clickerEmail = await this.getUserEmail(senderId);
    if (payload.senderEmail) {
      if (
        !clickerEmail ||
        clickerEmail.toLowerCase() !== payload.senderEmail.toLowerCase()
      ) {
        await this.sendTextMessage({
          to: senderId,
          body: "Only the person who started this request can approve or deny it.",
        });
        return;
      }
    } else if (senderId !== payload.senderId) {
      await this.sendTextMessage({
        to: senderId,
        body: "Only the person who started this request can approve or deny it.",
      });
      return;
    }

    const claimed =
      await cacheManager.getAndDelete<WhatsAppApprovalCallbackPayload>(
        cacheKey,
      );
    if (!claimed) {
      await this.sendTextMessage({
        to: senderId,
        body: "This approval request was already handled.",
      });
      return;
    }

    if (!this.eventHandler) return;

    await this.eventHandler.handleInteractiveApprovalDecision({
      provider: this,
      taskId: claimed.taskId,
      approvalId: claimed.approvalId,
      decision: action === "a" ? "approved" : "denied",
      toolName: claimed.toolName,
      approverEmail: clickerEmail ?? undefined,
      approverName: senderName,
      originalMessage: {
        messageId: `whatsapp-approval-${claimed.approvalId}`,
        channelId: claimed.channelId,
        workspaceId: null,
        threadId: claimed.threadId,
        senderId: claimed.senderId,
        senderName: claimed.senderName,
        text: "",
        rawText: "",
        timestamp: new Date(),
        isThreadReply: false,
        metadata: claimed.metadata,
      },
    });
  }

  private async handleCommand(
    message: WhatsAppInboundMessage,
    senderName: string,
  ): Promise<boolean> {
    if (message.type !== "text") return false;
    const trimmed = (message.text?.body ?? "").trim();
    if (!trimmed.startsWith("/")) return false;

    const spaceIdx = trimmed.indexOf(" ");
    const rawCmd = (
      spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
    ).toLowerCase();
    const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    if (rawCmd === "/start" || rawCmd === "/link") {
      const reply = await this.handleStartCommand(message.from, arg);
      await this.sendTextMessage({ to: message.from, body: reply });
      return true;
    }

    if (rawCmd === CHATOPS_COMMANDS.HELP) {
      await this.sendTextMessage({ to: message.from, body: HELP_TEXT });
      return true;
    }

    if (
      rawCmd === CHATOPS_COMMANDS.SELECT_AGENT ||
      rawCmd === "/select_agent"
    ) {
      await this.handleSelectAgentCommand(message, senderName);
      return true;
    }

    return false;
  }

  private async handleStartCommand(
    waId: string,
    codeArg: string,
  ): Promise<string> {
    const existing = await ChatOpsChannelBindingModel.findByChannel({
      provider: this.providerId,
      channelId: waId,
      workspaceId: null,
    });

    if (!codeArg) {
      if (existing?.dmOwnerEmail) {
        return `✅ This WhatsApp number is already linked to ${existing.dmOwnerEmail}. Send a message to get started!`;
      }
      const code = randomUUID();
      await cacheManager.set(
        `${CacheKey.WhatsAppLinkCode}-${code}`,
        { waId },
        WHATSAPP_LINK_CODE_TTL_MS,
      );
      return [
        "Let's link this WhatsApp number to your user account.",
        "",
        `Open ${config.frontendBaseUrl}/link-whatsapp?code=${code} and sign in to finish linking.`,
        "",
        "This link expires in 15 minutes.",
      ].join("\n");
    }

    if (!UUID_RE.test(codeArg)) {
      return "That linking code does not look valid. Generate a fresh link in the web app or send /start here.";
    }

    const cached = await cacheManager.getAndDelete<{ email?: string }>(
      `${CacheKey.WhatsAppLinkCode}-${codeArg}`,
    );
    if (!cached?.email) {
      return "This linking code is invalid or expired. Generate a fresh link in the web app or send /start here.";
    }

    if (
      existing?.dmOwnerEmail &&
      existing.dmOwnerEmail.toLowerCase() !== cached.email.toLowerCase()
    ) {
      return "This WhatsApp number is already linked to a different user account.";
    }

    const org = await OrganizationModel.getFirst();
    if (!org) {
      return "Your organization has not been set up yet. Try again once an administrator has signed in.";
    }

    if (!existing) {
      const pendingDm =
        await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
          organizationId: org.id,
          provider: this.providerId,
          dmOwnerEmail: cached.email,
        });
      if (pendingDm) {
        await ChatOpsChannelBindingModel.fulfillDmBinding({
          id: pendingDm.id,
          organizationId: org.id,
          realChannelId: waId,
          workspaceId: null,
        });
      } else {
        await ChatOpsChannelBindingModel.create({
          organizationId: org.id,
          provider: this.providerId,
          channelId: waId,
          isDm: true,
          dmOwnerEmail: cached.email,
          channelName: `Direct Message - ${cached.email}`,
          agentId: null,
        });
      }
    }

    logger.info(
      { waId, email: cached.email },
      "[WhatsAppProvider] Linked WhatsApp account via deep link",
    );
    return `✅ Linked to ${cached.email}. Send a message to start chatting!`;
  }

  private async handleSelectAgentCommand(
    message: WhatsAppInboundMessage,
    senderName: string,
  ): Promise<void> {
    if (!this.eventHandler) return;
    const senderEmail = await this.getUserEmail(message.from);
    if (!senderEmail) {
      await this.sendTextMessage({
        to: message.from,
        body: this.identityVerificationFailureText(),
      });
      return;
    }

    const agents = await this.eventHandler.getAccessibleChatopsAgents({
      senderEmail,
      isDm: true,
    });
    if (agents.length === 0) {
      await this.sendTextMessage({
        to: message.from,
        body: "No agents are available for your account yet. Ask an administrator to grant you access to an agent.",
      });
      return;
    }

    const synthetic: IncomingChatMessage = {
      messageId: `whatsapp:${message.from}:${message.id}`,
      channelId: message.from,
      workspaceId: null,
      senderId: message.from,
      senderName,
      text: "",
      rawText: "",
      timestamp: parseWhatsAppTimestamp(message.timestamp),
      isThreadReply: false,
      metadata: {
        channelType: "im",
        conversationType: "personal",
      },
    };
    await this.sendAgentSelectionCard({
      message: synthetic,
      agents,
      isWelcome: false,
    });
  }

  private async downloadMessageAttachments(
    message: WhatsAppInboundMessage,
  ): Promise<{
    attachments: A2AAttachment[];
    skippedAttachments: SkippedAttachment[];
  }> {
    const attachments: A2AAttachment[] = [];
    const skippedAttachments: SkippedAttachment[] = [];

    const mediaItems: Array<{
      id: string;
      name: string;
      mimeType: string;
    }> = [];

    if (message.image?.id) {
      mediaItems.push({
        id: message.image.id,
        name: "image.jpg",
        mimeType: message.image.mime_type ?? "image/jpeg",
      });
    }
    if (message.document?.id) {
      mediaItems.push({
        id: message.document.id,
        name: message.document.filename ?? "document",
        mimeType: message.document.mime_type ?? "application/octet-stream",
      });
    }
    if (message.audio?.id) {
      mediaItems.push({
        id: message.audio.id,
        name: "audio.ogg",
        mimeType: message.audio.mime_type ?? "audio/ogg",
      });
    }

    for (const item of mediaItems) {
      try {
        const meta = await this.callGraphGet<{
          url?: string;
          file_size?: number;
          mime_type?: string;
        }>(`/${encodeURIComponent(item.id)}`);

        if (
          typeof meta.file_size === "number" &&
          meta.file_size > CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE
        ) {
          skippedAttachments.push({
            name: item.name,
            sizeBytes: meta.file_size,
            reason: "too_large",
          });
          continue;
        }
        if (!meta.url) {
          throw new Error("Media metadata response missing download url");
        }

        const downloadResp = await fetch(meta.url, {
          headers: { Authorization: `Bearer ${this.config.accessToken}` },
          signal: AbortSignal.timeout(WHATSAPP_API_TIMEOUT_MS),
        });
        if (!downloadResp.ok) {
          throw new Error(
            `Media download failed with status ${downloadResp.status}`,
          );
        }
        const buffer = Buffer.from(await downloadResp.arrayBuffer());
        if (buffer.length > CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE) {
          skippedAttachments.push({
            name: item.name,
            sizeBytes: buffer.length,
            reason: "too_large",
          });
          continue;
        }
        attachments.push({
          contentType: meta.mime_type ?? item.mimeType,
          contentBase64: buffer.toString("base64"),
          name: item.name,
        });
      } catch (error) {
        logger.warn(
          { error: errorMessage(error), name: item.name },
          "[WhatsAppProvider] Failed to download attachment",
        );
        skippedAttachments.push({
          name: item.name,
          reason: "download_failed",
        });
      }
    }

    return { attachments, skippedAttachments };
  }

  private async fetchPhoneNumberMetadata(): Promise<{
    id: string;
    display_phone_number?: string;
    verified_name?: string;
  }> {
    return this.callGraphGet(
      `/${encodeURIComponent(this.config.phoneNumberId)}?fields=id,display_phone_number,verified_name`,
    );
  }

  private async sendTextMessage(params: {
    to: string;
    body: string;
    replyToMessageId?: string;
  }): Promise<string> {
    const response = await this.callMessagesApi({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.to,
      type: "text",
      ...(params.replyToMessageId && {
        context: { message_id: params.replyToMessageId },
      }),
      text: {
        preview_url: false,
        body: params.body,
      },
    });
    return response.messages?.[0]?.id ?? "";
  }

  private async callMessagesApi(
    payload: Record<string, unknown>,
  ): Promise<{ messages?: Array<{ id: string }> }> {
    const response = await fetch(
      `${WHATSAPP_GRAPH_API_BASE}/${encodeURIComponent(this.config.phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WHATSAPP_API_TIMEOUT_MS),
      },
    );
    const body = (await response.json()) as {
      messages?: Array<{ id: string }>;
      error?: { message?: string; code?: number };
    };
    if (!response.ok || body.error) {
      throw new Error(
        `WhatsApp messages API failed (${body.error?.code ?? response.status}): ${body.error?.message ?? response.statusText}`,
      );
    }
    return body;
  }

  private async callGraphGet<T>(pathWithLeadingSlash: string): Promise<T> {
    const response = await fetch(
      `${WHATSAPP_GRAPH_API_BASE}${pathWithLeadingSlash}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
        },
        signal: AbortSignal.timeout(WHATSAPP_API_TIMEOUT_MS),
      },
    );
    const body = (await response.json()) as T & {
      error?: { message?: string; code?: number };
    };
    if (!response.ok || body.error) {
      throw new Error(
        `WhatsApp Graph API GET failed (${body.error?.code ?? response.status}): ${body.error?.message ?? response.statusText}`,
      );
    }
    return body;
  }
}

export default WhatsAppProvider;

// =============================================================================
// Internal Helpers
// =============================================================================

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function normalizePhoneDigits(phone: string): string {
  return phone.replace(/\D+/g, "");
}

function parseWhatsAppTimestamp(ts?: string): Date {
  const seconds = Number(ts);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000);
  }
  return new Date();
}

function extractMessageText(message: WhatsAppInboundMessage): string {
  if (message.type === "text") {
    return message.text?.body ?? "";
  }
  if (message.type === "button") {
    return message.button?.text ?? message.button?.payload ?? "";
  }
  if (message.type === "interactive") {
    return (
      message.interactive?.button_reply?.title ??
      message.interactive?.list_reply?.title ??
      ""
    );
  }
  if (message.type === "image") {
    return message.image?.caption ?? "";
  }
  if (message.type === "document") {
    return message.document?.caption ?? "";
  }
  return "";
}

function formatApprovalPromptBody(params: {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  explanation?: string;
}): string {
  const lines = [
    "*Approval required*",
    `Tool: \`${params.toolName}\``,
    "Review this tool call before it can continue.",
  ];
  if (params.explanation) {
    lines.push("", truncatePlain(params.explanation, 300));
  }
  const entries = Object.entries(params.toolArgs ?? {});
  if (entries.length > 0) {
    lines.push("");
    for (const [key, raw] of entries.slice(0, 6)) {
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      lines.push(`${key}: ${truncatePlain(text ?? String(raw), 100)}`);
    }
  }
  return truncatePlain(lines.join("\n"), WHATSAPP_INTERACTIVE_BODY_LIMIT);
}

function truncatePlain(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

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

function approvalCacheKey(key: string): AllowedCacheKey {
  return `${CacheKey.WhatsAppApprovalCallback}-${key}`;
}

const WHATSAPP_GRAPH_API_BASE = "https://graph.facebook.com/v21.0";
const WHATSAPP_API_TIMEOUT_MS = 15_000;
const WHATSAPP_MESSAGE_CHUNK_SIZE = 4_000;
const WHATSAPP_INTERACTIVE_BODY_LIMIT = 1_024;
const WHATSAPP_BUTTON_TITLE_LIMIT = 20;
const WHATSAPP_ROW_TITLE_LIMIT = 24;
const MAX_BUTTON_AGENTS = 3;
const MAX_LIST_AGENTS = 10;
const APPROVAL_CALLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_SELECT_PREFIX = "agent_select";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HELP_TEXT = [
  "Here is what I can do:",
  "",
  "- Send a message and I will pass it to your assigned agent.",
  "- /select-agent: choose which agent answers in this chat.",
  "- /reset: start a new conversation.",
  "- AgentName > message: route a single message to another agent.",
  "- /start: link your WhatsApp number to your user account.",
].join("\n");

interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: {
          display_phone_number?: string;
          phone_number_id?: string;
        };
        contacts?: Array<{
          wa_id?: string;
          profile?: { name?: string };
        }>;
        messages?: WhatsAppInboundMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
}

interface WhatsAppInboundMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  context?: { from?: string; id?: string };
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  image?: { id?: string; mime_type?: string; caption?: string };
  document?: {
    id?: string;
    filename?: string;
    mime_type?: string;
    caption?: string;
  };
  audio?: { id?: string; mime_type?: string };
}

interface WhatsAppSingleMessageEnvelope {
  __whatsappSingleMessage: true;
  message: WhatsAppInboundMessage;
  senderName: string;
  phoneNumberId?: string;
}

interface WhatsAppInteractiveSelectionPayload {
  id: string;
  from: string;
  senderName: string;
}

interface WhatsAppApprovalCallbackPayload {
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
