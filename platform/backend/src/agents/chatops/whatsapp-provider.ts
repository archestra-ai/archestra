import { createHmac, timingSafeEqual } from "node:crypto";
import logger from "@/logging";
import { ChatOpsChannelBindingModel } from "@/models";
import type {
  AddApprovalRequestFormOptions,
  ChatOpsEventHandler,
  ChatOpsProvider,
  ChatOpsProviderType,
  ChatReplyOptions,
  ChatThreadMessage,
  ChatThreadMessageFile,
  DiscoveredChannel,
  IncomingChatMessage,
  ThreadFileOutcome,
  ThreadHistoryParams,
  UpdateApprovalRequestOptions,
  WhatsAppDbConfig,
} from "@/types";
import {
  WHATSAPP_GRAPH_API_VERSION,
  WHATSAPP_MAX_MESSAGE_LENGTH,
} from "./constants";
import {
  errorMessage,
  formatApprovalReviewText,
  stripDuplicateAgentFooter,
} from "./utils";

const AGENT_SELECT_PREFIX = "agent_select";
const APPROVAL_APPROVE_PREFIX = "approve";
const APPROVAL_DECLINE_PREFIX = "decline";

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
          profile?: { name?: string };
          wa_id?: string;
        }>;
        messages?: WhatsAppIncomingMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
}

interface WhatsAppIncomingMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  context?: {
    from?: string;
    id?: string;
  };
  text?: { body?: string };
  button?: { payload?: string; text?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  image?: { caption?: string; id?: string; mime_type?: string };
  document?: {
    caption?: string;
    filename?: string;
    id?: string;
    mime_type?: string;
  };
  video?: { caption?: string; id?: string; mime_type?: string };
  audio?: { id?: string; mime_type?: string };
}

interface WhatsAppSendMessageResponse {
  messaging_product?: string;
  contacts?: Array<{ input?: string; wa_id?: string }>;
  messages?: Array<{ id?: string }>;
}

/**
 * WhatsApp Cloud API (Meta Graph API) chatops provider.
 *
 * Security:
 * - Webhook GET verification compares `hub.verify_token` using timingSafeEqual
 * - Webhook POST requests are verified via `X-Hub-Signature-256` (HMAC-SHA256
 *   over the exact raw request bytes using the Meta App Secret)
 *
 * Messaging model:
 * - Uses server-side sessions (`usesServerSideSessions = true`) because the
 *   WhatsApp Cloud API does not expose a message history endpoint.
 * - Direct 1:1 conversations keyed by sender `wa_id` (phone number).
 */
class WhatsAppProvider implements ChatOpsProvider {
  readonly providerId: ChatOpsProviderType = "whatsapp";
  readonly displayName = "WhatsApp";
  readonly usesServerSideSessions = true;

  private config: WhatsAppDbConfig;
  private eventHandler: ChatOpsEventHandler | null = null;

  constructor(whatsappConfig: WhatsAppDbConfig) {
    this.config = whatsappConfig;
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.enabled &&
        this.config.accessToken &&
        this.config.phoneNumberId &&
        this.config.verifyToken &&
        this.config.appSecret,
    );
  }

  setEventHandler(handler: ChatOpsEventHandler): void {
    this.eventHandler = handler;
  }

  getEventHandler(): ChatOpsEventHandler | null {
    return this.eventHandler;
  }

  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info("[WhatsAppProvider] Not configured, skipping initialization");
      return;
    }

    logger.info(
      { phoneNumberId: this.config.phoneNumberId },
      "[WhatsAppProvider] Initialized",
    );
  }

  async cleanup(): Promise<void> {
    this.eventHandler = null;
    logger.info("[WhatsAppProvider] Cleaned up");
  }

  /**
   * Verify `X-Hub-Signature-256: sha256=<hex>` against the raw request body
   * using the configured Meta App Secret.
   */
  async validateWebhookRequest(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    if (!this.config.appSecret) {
      return false;
    }

    const signatureHeader = getHeader(headers, "x-hub-signature-256");
    if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
      logger.warn(
        "[WhatsAppProvider] Missing or malformed X-Hub-Signature-256",
      );
      return false;
    }

    const rawBody =
      typeof payload === "string" || Buffer.isBuffer(payload) ? payload : null;
    if (rawBody === null) {
      logger.warn(
        "[WhatsAppProvider] Missing raw request body for signature verification",
      );
      return false;
    }

    const expectedHex = createHmac("sha256", this.config.appSecret)
      .update(rawBody)
      .digest("hex");
    const expectedHeader = `sha256=${expectedHex}`;

    return safeEqualStrings(signatureHeader, expectedHeader);
  }

  /**
   * Handle Meta webhook verification challenge (`GET /api/webhooks/chatops/whatsapp`).
   * Returns `hub.challenge` if `hub.mode === "subscribe"` and `hub.verify_token`
   * matches the configured verify token; otherwise returns `null`.
   */
  handleValidationChallenge(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const query = payload as Record<string, unknown>;
    const mode = typeof query["hub.mode"] === "string" ? query["hub.mode"] : "";
    const verifyToken =
      typeof query["hub.verify_token"] === "string"
        ? query["hub.verify_token"]
        : "";
    const challenge =
      typeof query["hub.challenge"] === "string" ? query["hub.challenge"] : "";

    if (mode !== "subscribe" || !challenge || !this.config.verifyToken) {
      return null;
    }

    if (!safeEqualStrings(verifyToken, this.config.verifyToken)) {
      logger.warn("[WhatsAppProvider] Webhook verify_token mismatch");
      return null;
    }

    return challenge;
  }

  async parseWebhookNotification(
    payload: unknown,
    _headers: Record<string, string | string[] | undefined>,
  ): Promise<IncomingChatMessage | null> {
    const body = payload as WhatsAppWebhookPayload | undefined;
    if (body?.object !== "whatsapp_business_account" || !body.entry?.length) {
      return null;
    }

    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages" || !change.value) {
          continue;
        }
        const value = change.value;
        const incomingPhoneNumberId = value.metadata?.phone_number_id;
        if (
          incomingPhoneNumberId &&
          this.config.phoneNumberId &&
          incomingPhoneNumberId !== this.config.phoneNumberId
        ) {
          logger.debug(
            {
              incomingPhoneNumberId,
              configuredPhoneNumberId: this.config.phoneNumberId,
            },
            "[WhatsAppProvider] Ignoring webhook for another phone_number_id",
          );
          continue;
        }

        const msg = value.messages?.[0];
        if (!msg?.from || !msg.id) {
          continue;
        }

        const extractedText = extractIncomingMessageText(msg);
        if (!extractedText) {
          continue;
        }

        const contact = value.contacts?.find((c) => c.wa_id === msg.from);
        const senderName = contact?.profile?.name?.trim() || msg.from;
        const parsedTimestamp = msg.timestamp
          ? Number.parseInt(msg.timestamp, 10)
          : Number.NaN;
        const timestamp = Number.isFinite(parsedTimestamp)
          ? new Date(parsedTimestamp * 1000)
          : new Date();

        return {
          messageId: msg.id,
          channelId: msg.from,
          workspaceId: incomingPhoneNumberId ?? this.config.phoneNumberId,
          threadId: msg.from,
          senderId: msg.from,
          senderName,
          text: extractedText,
          rawText: extractedText,
          timestamp,
          isThreadReply: Boolean(msg.context?.id),
          metadata: {
            channelType: "im",
            conversationType: "personal",
            whatsappMessageId: msg.id,
            phoneNumberId: incomingPhoneNumberId ?? this.config.phoneNumberId,
            ...(msg.context?.id ? { replyToMessageId: msg.context.id } : {}),
          },
        };
      }
    }

    return null;
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    const { originalMessage } = options;
    let text = options.footer
      ? stripDuplicateAgentFooter(options.text, options.footer)
      : options.text;
    if (options.hint) text += `\n\n${options.hint}`;
    if (options.footer) text += `\n\n${options.footer}`;

    const metadata = originalMessage.metadata ?? {};
    const replyToMessageId =
      typeof metadata.whatsappMessageId === "string"
        ? metadata.whatsappMessageId
        : undefined;

    const chunks = splitText(text, WHATSAPP_MAX_MESSAGE_LENGTH);
    let firstMessageId = "";

    for (let i = 0; i < chunks.length; i++) {
      const response = await this.callGraphApi<WhatsAppSendMessageResponse>(
        "messages",
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: originalMessage.channelId,
          type: "text",
          text: {
            preview_url: false,
            body: chunks[i],
          },
          ...(i === 0 && replyToMessageId
            ? { context: { message_id: replyToMessageId } }
            : {}),
        },
      );
      const sentId = response.messages?.[0]?.id ?? "";
      if (!firstMessageId && sentId) {
        firstMessageId = sentId;
      }
    }

    return firstMessageId;
  }

  async setTypingStatus(
    _channelId: string,
    _threadTs: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const messageId =
      typeof metadata?.whatsappMessageId === "string"
        ? metadata.whatsappMessageId
        : undefined;
    if (!messageId) return;

    try {
      await this.callGraphApi("messages", {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: {
          type: "text",
        },
      });
    } catch (error) {
      logger.debug(
        { error: errorMessage(error), messageId },
        "[WhatsAppProvider] Failed to send read/typing status (non-fatal)",
      );
    }
  }

  async addApprovalRequestForm(
    options: AddApprovalRequestFormOptions,
  ): Promise<void> {
    const bodyText = options.reviewText
      ? formatApprovalReviewText(options.reviewText)
      : `Approval required for tool: ${options.toolName}`;

    await this.callGraphApi("messages", {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: options.channelId,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: truncate(bodyText, 1024),
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: `${APPROVAL_APPROVE_PREFIX}|${options.approvalId}`,
                title: "Approve",
              },
            },
            {
              type: "reply",
              reply: {
                id: `${APPROVAL_DECLINE_PREFIX}|${options.approvalId}`,
                title: "Decline",
              },
            },
          ],
        },
      },
    });
  }

  async updateApprovalRequest(
    options: UpdateApprovalRequestOptions,
  ): Promise<void> {
    const statusText = options.approved
      ? `Approved: ${options.toolName}`
      : `Declined: ${options.toolName}`;
    await this.callGraphApi("messages", {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: options.channelId,
      type: "text",
      text: {
        preview_url: false,
        body: statusText,
      },
    });
  }

  async sendDirectMessage(params: {
    userId: string;
    text: string;
    actionUrl?: string;
    actionLabel?: string;
    channelId?: string;
    threadId?: string;
  }): Promise<void> {
    const recipient = params.channelId ?? params.userId;
    const body = params.actionUrl
      ? `${params.text}\n\n${params.actionLabel ?? "Open"}: ${params.actionUrl}`
      : params.text;

    for (const chunk of splitText(body, WHATSAPP_MAX_MESSAGE_LENGTH)) {
      await this.callGraphApi("messages", {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: {
          preview_url: false,
          body: chunk,
        },
      });
    }
  }

  async getThreadHistory(
    _params: ThreadHistoryParams,
  ): Promise<ChatThreadMessage[]> {
    return [];
  }

  /**
   * WhatsApp exposes phone numbers (`wa_id`) rather than email addresses.
   * Resolve the user's email from their DM channel binding.
   */
  async getUserEmail(userId: string): Promise<string | null> {
    const binding =
      (await ChatOpsChannelBindingModel.findByChannel({
        provider: this.providerId,
        channelId: userId,
        workspaceId: this.config.phoneNumberId,
      })) ??
      (await ChatOpsChannelBindingModel.findByChannel({
        provider: this.providerId,
        channelId: userId,
        workspaceId: null,
      }));
    return binding?.isDm ? (binding.dmOwnerEmail ?? null) : null;
  }

  identityVerificationFailureText(): string {
    return "This WhatsApp number isn't linked to an Archestra user account yet. Ask an administrator to assign your WhatsApp channel binding to your email.";
  }

  async getUserName(userId: string): Promise<string | null> {
    return userId;
  }

  async getChannelName(channelId: string): Promise<string | null> {
    return channelId;
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
    const body = payload as WhatsAppWebhookPayload | undefined;
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg?.from || msg.type !== "interactive") {
      return null;
    }

    const selectionId =
      msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id;
    if (!selectionId || !selectionId.startsWith(`${AGENT_SELECT_PREFIX}|`)) {
      return null;
    }

    const agentId = selectionId.slice(AGENT_SELECT_PREFIX.length + 1);
    if (!agentId) {
      return null;
    }

    const contact = value?.contacts?.find((c) => c.wa_id === msg.from);
    const userName = contact?.profile?.name?.trim() || msg.from;

    return {
      agentId,
      channelId: msg.from,
      workspaceId:
        value?.metadata?.phone_number_id ?? this.config.phoneNumberId,
      threadTs: msg.from,
      userId: msg.from,
      userName,
      responseUrl: "",
      isDm: true,
    };
  }

  async sendAgentSelectionCard(params: {
    message: IncomingChatMessage;
    agents: { id: string; name: string }[];
    isWelcome: boolean;
  }): Promise<void> {
    const headerText = params.isWelcome
      ? "Hi! Choose the agent for this conversation:"
      : "Choose an agent:";

    if (params.agents.length === 0) {
      await this.sendDirectMessage({
        userId: params.message.senderId,
        channelId: params.message.channelId,
        text: "No agents are currently available.",
      });
      return;
    }

    // WhatsApp interactive button messages allow up to 3 buttons.
    if (params.agents.length <= 3) {
      await this.callGraphApi("messages", {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: params.message.channelId,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: headerText },
          action: {
            buttons: params.agents.map((agent) => ({
              type: "reply",
              reply: {
                id: `${AGENT_SELECT_PREFIX}|${agent.id}`,
                title: truncate(agent.name, 20),
              },
            })),
          },
        },
      });
      return;
    }

    // For >3 agents, WhatsApp interactive list messages allow up to 10 rows.
    await this.callGraphApi("messages", {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.message.channelId,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: headerText },
        action: {
          button: "Select Agent",
          sections: [
            {
              title: "Available Agents",
              rows: params.agents.slice(0, 10).map((agent) => ({
                id: `${AGENT_SELECT_PREFIX}|${agent.id}`,
                title: truncate(agent.name, 24),
              })),
            },
          ],
        },
      },
    });
  }

  getWorkspaceId(): string | null {
    return this.config.phoneNumberId || null;
  }

  getWorkspaceName(): string | null {
    return "WhatsApp";
  }

  hasMissingScopes(): boolean {
    return false;
  }

  async notifyMissingScopes(): Promise<void> {
    // WhatsApp Cloud API uses a static System User token configured in Meta Business Manager.
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
    // WhatsApp Cloud API does not list conversations proactively; bindings are
    // created when incoming messages arrive or manually by an admin.
    return null;
  }

  private async callGraphApi<T = unknown>(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${encodeURIComponent(this.config.phoneNumberId)}/${endpoint}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `WhatsApp Cloud API error (${response.status}): ${errorText || response.statusText}`,
      );
    }

    return (await response.json()) as T;
  }
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function extractIncomingMessageText(msg: WhatsAppIncomingMessage): string {
  switch (msg.type) {
    case "text":
      return msg.text?.body?.trim() ?? "";
    case "button":
      return (msg.button?.text ?? msg.button?.payload ?? "").trim();
    case "interactive": {
      const buttonReply = msg.interactive?.button_reply;
      if (buttonReply) {
        return (buttonReply.title ?? buttonReply.id ?? "").trim();
      }
      const listReply = msg.interactive?.list_reply;
      if (listReply) {
        return (listReply.title ?? listReply.id ?? "").trim();
      }
      return "";
    }
    case "image":
      return msg.image?.caption?.trim() ?? "";
    case "document":
      return msg.document?.caption?.trim() ?? "";
    case "video":
      return msg.video?.caption?.trim() ?? "";
    default:
      return "";
  }
}

function splitText(text: string, maxLength: number): string[] {
  if (!text) return [""];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= maxLength * 0.5) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export default WhatsAppProvider;
