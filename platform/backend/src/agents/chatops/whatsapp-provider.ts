import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { ChatOpsChannelBindingModel } from "@/models";
import type {
  AddApprovalRequestFormOptions,
  ChatOpsApprovalDecision,
  ChatOpsEventHandler,
  ChatOpsProvider,
  ChatOpsProviderType,
  ChatReplyOptions,
  ChatThreadMessage,
  DiscoveredChannel,
  IncomingChatMessage,
  ThreadHistoryParams,
  UpdateApprovalRequestOptions,
  WhatsAppDbConfig,
} from "@/types";
import {
  errorMessage,
  formatApprovalAlsoAccepts,
  stripDuplicateAgentFooter,
} from "./utils";

const WORKSPACE_ID = "whatsapp";
const APPROVAL_CALLBACK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppApprovalCallbackPayload {
  taskId: string;
  approvalId: string;
  toolName: string;
  channelId: string;
  senderEmail?: string;
  senderId: string;
  senderName: string;
}

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
        messages?: Array<WhatsAppRawMessage>;
        statuses?: Array<unknown>;
      };
    }>;
  }>;
}

interface WhatsAppRawMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  interactive?: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: { payload: string; text: string };
}

/**
 * Normalizes phone numbers to standard E.164 digits-only format.
 * Strips '+', dashes, spaces, brackets, and any WhatsApp JID suffixes.
 */
export function normalizePhoneNumber(phone: string): string {
  if (!phone) return "";
  const cleaned = phone
    .replace(/@s\.whatsapp\.net$/i, "")
    .replace(/@c\.us$/i, "")
    .replace(/@g\.us$/i, "")
    .replace(/[^\d]/g, "");
  return cleaned;
}

/**
 * WhatsApp Cloud API ChatOps Provider.
 *
 * Implements ChatOpsProvider for WhatsApp:
 * - Validates Meta webhook challenge handshake (hub.challenge / hub.verify_token).
 * - Verifies Meta SHA-256 HMAC webhook signatures (x-hub-signature-256).
 * - Ingests incoming 1:1 text messages and maps sender phone numbers to Archestra user emails.
 * - Dispatches responses via Meta Graph API v19.0.
 * - Handles interactive Human-in-the-Loop (HITL) approval forms and reactions.
 * - Keeps server-side conversation sessions consistent with Telegram and MS Teams 1:1.
 */
export class WhatsAppProvider implements ChatOpsProvider {
  readonly providerId: ChatOpsProviderType = "whatsapp";
  readonly displayName = "WhatsApp";
  readonly usesServerSideSessions = true;

  private config: WhatsAppDbConfig;
  private eventHandler: ChatOpsEventHandler | null = null;

  constructor(config: WhatsAppDbConfig) {
    this.config = config;
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.enabled &&
        this.config.phoneNumberId &&
        this.config.accessToken &&
        this.config.verifyToken,
    );
  }

  setEventHandler(handler: ChatOpsEventHandler): void {
    this.eventHandler = handler;
  }

  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info("[WhatsAppProvider] Not configured, skipping initialization");
      return;
    }
    logger.info(
      { phoneNumberId: this.config.phoneNumberId },
      "[WhatsAppProvider] Initialized successfully",
    );
  }

  async cleanup(): Promise<void> {
    this.eventHandler = null;
    logger.info("[WhatsAppProvider] Cleaned up");
  }

  async validateWebhookRequest(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    if (!this.config.appSecret) {
      // If appSecret is not provided, we accept if configured
      return true;
    }

    const signature = getHeader(headers, "x-hub-signature-256");
    if (!signature?.startsWith("sha256=")) {
      logger.warn("[WhatsAppProvider] Missing or malformed signature header");
      return false;
    }

    const signatureHash = signature.slice("sha256=".length);
    const body =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    const expectedHash = createHmac("sha256", this.config.appSecret)
      .update(body)
      .digest("hex");

    try {
      const sigBuf = Buffer.from(signatureHash, "hex");
      const expBuf = Buffer.from(expectedHash, "hex");
      if (sigBuf.length !== expBuf.length) {
        return false;
      }
      return timingSafeEqual(sigBuf, expBuf);
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[WhatsAppProvider] Signature comparison failed",
      );
      return false;
    }
  }

  handleValidationChallenge(payload: unknown): unknown | null {
    const query = payload as Record<string, unknown> | undefined;
    if (
      query?.["hub.mode"] === "subscribe" &&
      query["hub.verify_token"] === this.config.verifyToken &&
      query["hub.challenge"]
    ) {
      return query["hub.challenge"];
    }
    return null;
  }

  async parseWebhookNotification(
    payload: unknown,
    _headers?: Record<string, string | string[] | undefined>,
  ): Promise<IncomingChatMessage | null> {
    const data = payload as WhatsAppWebhookPayload | undefined;
    const entry = data?.entry?.[0];
    const change = entry?.changes?.find((item) => item.field === "messages");
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message?.from) {
      return null;
    }

    const senderPhone = normalizePhoneNumber(message.from);
    const contact = value?.contacts?.find(
      (c) => normalizePhoneNumber(c.wa_id ?? "") === senderPhone,
    );
    const senderName = contact?.profile?.name || senderPhone;
    const senderEmail = (await this.getUserEmail(senderPhone)) ?? undefined;

    let text = "";
    let isInteractive = false;
    let interactiveId: string | undefined;

    if (message.type === "text" && message.text?.body) {
      text = message.text.body;
    } else if (
      message.type === "interactive" &&
      message.interactive?.button_reply
    ) {
      isInteractive = true;
      interactiveId = message.interactive.button_reply.id;
      text = message.interactive.button_reply.title;
    } else if (message.type === "button" && message.button) {
      isInteractive = true;
      interactiveId = message.button.payload;
      text = message.button.text;
    } else {
      // Ignore unsupported message types (media, location, etc.) gracefully
      return null;
    }

    const rawText = text;
    const timestamp = message.timestamp
      ? new Date(Number(message.timestamp) * 1000)
      : new Date();

    const incoming: IncomingChatMessage = {
      messageId: message.id,
      channelId: senderPhone,
      workspaceId: WORKSPACE_ID,
      senderId: senderPhone,
      senderName,
      senderEmail,
      text: text.trim(),
      rawText,
      timestamp,
      isThreadReply: false,
      metadata: {
        whatsappMessageId: message.id,
        phoneNumberId: value?.metadata?.phone_number_id,
        isInteractive,
        interactiveId,
      },
    };

    // Check if this interactive message or text command is an approval decision
    if (this.eventHandler && (isInteractive || isApprovalText(text))) {
      const handled = await this.tryHandleApprovalDecision(
        incoming,
        interactiveId,
      );
      if (handled) return null;
    }

    return incoming;
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    if (!this.config.accessToken || !this.config.phoneNumberId) {
      throw new Error(
        "WhatsApp provider is missing access token or phone number ID",
      );
    }

    let text = options.footer
      ? stripDuplicateAgentFooter(options.text, options.footer)
      : options.text;
    if (options.hint) text += `\n\n${options.hint}`;
    if (options.footer) text += `\n\n${options.footer}`;

    const recipient = normalizePhoneNumber(options.originalMessage.channelId);
    const url = `https://graph.facebook.com/v19.0/${this.config.phoneNumberId}/messages`;

    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "text",
      text: {
        preview_url: false,
        body: text,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      logger.error(
        { status: response.status, body: errBody },
        "[WhatsAppProvider] Failed to send reply via WhatsApp Cloud API",
      );
      throw new Error(
        `WhatsApp API responded with status ${response.status}: ${errBody}`,
      );
    }

    const data = (await response.json()) as {
      messages?: Array<{ id: string }>;
    };
    return data.messages?.[0]?.id ?? options.originalMessage.messageId;
  }

  async addApprovalRequestForm(
    options: AddApprovalRequestFormOptions,
  ): Promise<void> {
    if (!this.config.accessToken || !this.config.phoneNumberId) return;

    const key = randomUUID();
    const payload: WhatsAppApprovalCallbackPayload = {
      taskId: options.taskId,
      approvalId: options.approvalId,
      toolName: options.toolName,
      channelId: options.originalMessage.channelId,
      senderEmail: options.originalMessage.senderEmail,
      senderId: options.originalMessage.senderId,
      senderName: options.originalMessage.senderName,
    };

    await cacheManager.set(
      approvalCacheKey(key),
      payload,
      APPROVAL_CALLBACK_TTL_MS,
    );

    const reviewText = options.reviewText
      ? options.reviewText
      : `Action review required for tool: ${options.toolName}`;

    const alsoAcceptsText = options.alsoAccepts?.length
      ? `\n${formatApprovalAlsoAccepts(options.alsoAccepts)}`
      : "";

    const text = `${reviewText}${alsoAcceptsText}\n\nPlease reply with *Approve* or *Decline*.`;

    const recipient = normalizePhoneNumber(options.channelId);
    const url = `https://graph.facebook.com/v19.0/${this.config.phoneNumberId}/messages`;

    // Send interactive button message
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text,
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: `wa_appr|${key}|a`,
                title: "Approve",
              },
            },
            {
              type: "reply",
              reply: {
                id: `wa_appr|${key}|d`,
                title: "Decline",
              },
            },
          ],
        },
      },
    };

    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async updateApprovalRequest(
    options: UpdateApprovalRequestOptions,
  ): Promise<void> {
    const status = options.approved ? "Approved" : "Declined";
    const statusText = `Decision recorded: *${status}* for ${options.toolName}.`;
    const recipient = normalizePhoneNumber(options.channelId);

    if (!this.config.accessToken || !this.config.phoneNumberId) return;

    const url = `https://graph.facebook.com/v19.0/${this.config.phoneNumberId}/messages`;
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: { preview_url: false, body: statusText },
      }),
    });
  }

  async setTypingStatus(
    channelId: string,
    threadTs: string,
    _metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.accessToken || !this.config.phoneNumberId) return;

    // Send a 💭 reaction to acknowledge thinking state
    const recipient = normalizePhoneNumber(channelId);
    const url = `https://graph.facebook.com/v19.0/${this.config.phoneNumberId}/messages`;

    try {
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipient,
          type: "reaction",
          reaction: {
            message_id: threadTs,
            emoji: "💭",
          },
        }),
      });
    } catch {
      // Non-fatal if reaction is not accepted
    }
  }

  async clearTypingStatus(
    channelId: string,
    threadTs: string,
    _metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.accessToken || !this.config.phoneNumberId) return;

    const recipient = normalizePhoneNumber(channelId);
    const url = `https://graph.facebook.com/v19.0/${this.config.phoneNumberId}/messages`;

    try {
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipient,
          type: "reaction",
          reaction: {
            message_id: threadTs,
            emoji: "",
          },
        }),
      });
    } catch {
      // Non-fatal
    }
  }

  async getThreadHistory(
    _params: ThreadHistoryParams,
  ): Promise<ChatThreadMessage[]> {
    // WhatsApp Cloud API has no message history retrieval endpoint.
    // History is maintained server-side via persistent sessions.
    return [];
  }

  async getUserEmail(userId: string): Promise<string | null> {
    const normalized = normalizePhoneNumber(userId);
    const mapped = this.config.phoneEmailMappings?.find(
      (m) => normalizePhoneNumber(m.phone) === normalized,
    );
    if (mapped?.email) return mapped.email;

    const binding = await ChatOpsChannelBindingModel.findByChannel({
      provider: this.providerId,
      channelId: normalized,
      workspaceId: WORKSPACE_ID,
    });
    return binding?.isDm ? (binding.dmOwnerEmail ?? null) : null;
  }

  identityVerificationFailureText(): string {
    return "This WhatsApp phone number is not linked to an Archestra user. Please configure a phone-to-email mapping in your workspace settings.";
  }

  async discoverChannels(
    _context: unknown,
  ): Promise<DiscoveredChannel[] | null> {
    return null;
  }

  private async tryHandleApprovalDecision(
    message: IncomingChatMessage,
    interactiveId?: string,
  ): Promise<boolean> {
    if (!this.eventHandler) return false;

    let key: string | undefined;
    let approved: boolean | undefined;

    if (interactiveId?.startsWith("wa_appr|")) {
      const parts = interactiveId.split("|");
      key = parts[1];
      approved = parts[2] === "a";
    }

    if (!key) return false;

    const payload = await cacheManager.get<WhatsAppApprovalCallbackPayload>(
      approvalCacheKey(key),
    );
    if (!payload) return false;

    const decision: ChatOpsApprovalDecision = {
      taskId: payload.taskId,
      approvalId: payload.approvalId,
      approved: Boolean(approved),
      toolName: payload.toolName,
      messageTs: message.messageId,
      channelId: payload.channelId,
      workspaceId: WORKSPACE_ID,
      originalMessage: message,
      userId: message.senderId,
      userName: message.senderName,
      responseUrl: "",
      approverEmail: message.senderEmail ?? payload.senderEmail,
    };

    await this.eventHandler.handleInteractiveApprovalDecision(this, decision);
    await cacheManager.delete(approvalCacheKey(key));
    return true;
  }
}

export default WhatsAppProvider;

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

function approvalCacheKey(key: string): AllowedCacheKey {
  return `${CacheKey.WhatsAppApprovalCallback}-${key}` as AllowedCacheKey;
}

function isApprovalText(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower === "approve" ||
    lower === "approved" ||
    lower === "yes" ||
    lower === "decline" ||
    lower === "declined" ||
    lower === "no"
  );
}
