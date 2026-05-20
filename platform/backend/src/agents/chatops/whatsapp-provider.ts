import { createHmac, timingSafeEqual } from "node:crypto";
import logger from "@/logging";
import type {
  AddApprovalRequestFormOptions,
  ChatOpsProvider,
  ChatOpsProviderType,
  ChatReplyOptions,
  ChatThreadMessage,
  ChatThreadMessageFile,
  DiscoveredChannel,
  IncomingChatMessage,
  ThreadHistoryParams,
  UpdateApprovalRequestOptions,
  WhatsAppDbConfig,
} from "@/types";
import { errorMessage } from "./utils";

interface WhatsAppWebhookChallenge {
  "hub.challenge"?: string;
  "hub.mode"?: string;
  "hub.verify_token"?: string;
}

interface WhatsAppWebhookPayload {
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        contacts?: Array<{
          profile?: { name?: string };
          wa_id?: string;
        }>;
        messages?: Array<{
          from?: string;
          id?: string;
          text?: { body?: string };
          timestamp?: string;
          type?: string;
        }>;
        metadata?: {
          display_phone_number?: string;
          phone_number_id?: string;
        };
      };
    }>;
  }>;
}

class WhatsAppProvider implements ChatOpsProvider {
  readonly providerId: ChatOpsProviderType = "whatsapp";
  readonly displayName = "WhatsApp";

  private readonly config: WhatsAppDbConfig;

  constructor(config: WhatsAppDbConfig) {
    this.config = config;
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.enabled &&
        this.config.accessToken &&
        this.config.appSecret &&
        this.config.phoneNumberId &&
        this.config.verifyToken,
    );
  }

  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info("[WhatsAppProvider] Not configured, skipping initialization");
      return;
    }
    logger.info("[WhatsAppProvider] Initialized");
  }

  async cleanup(): Promise<void> {
    logger.info("[WhatsAppProvider] Cleaned up");
  }

  async validateWebhookRequest(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    const signature = getHeader(headers, "x-hub-signature-256");
    if (!signature?.startsWith("sha256=")) {
      logger.warn("[WhatsAppProvider] Missing or malformed signature header");
      return false;
    }

    const body =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    const expectedSignature = `sha256=${createHmac("sha256", this.config.appSecret).update(body).digest("hex")}`;

    try {
      const signatureBuffer = Buffer.from(signature, "utf8");
      const expectedBuffer = Buffer.from(expectedSignature, "utf8");
      if (signatureBuffer.length !== expectedBuffer.length) {
        return false;
      }
      return timingSafeEqual(signatureBuffer, expectedBuffer);
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[WhatsAppProvider] Signature comparison failed",
      );
      return false;
    }
  }

  handleValidationChallenge(payload: unknown): string | null {
    const challenge = payload as WhatsAppWebhookChallenge;
    if (
      challenge?.["hub.mode"] !== "subscribe" ||
      challenge["hub.verify_token"] !== this.config.verifyToken ||
      !challenge["hub.challenge"]
    ) {
      return null;
    }
    return challenge["hub.challenge"];
  }

  async parseWebhookNotification(
    payload: unknown,
    _headers: Record<string, string | string[] | undefined>,
  ): Promise<IncomingChatMessage | null> {
    const parsed = payload as WhatsAppWebhookPayload;
    const entry = parsed.entry?.[0];
    const change = entry?.changes?.find((item) => item.field === "messages");
    const value = change?.value;
    const phoneNumberId = value?.metadata?.phone_number_id;
    if (phoneNumberId !== this.config.phoneNumberId) {
      return null;
    }

    const message = value?.messages?.[0];
    if (!message || message.type !== "text" || !message.text?.body) {
      return null;
    }

    const senderId = message.from;
    const messageId = message.id;
    if (!senderId || !messageId) {
      return null;
    }

    const contact = value?.contacts?.find((item) => item.wa_id === senderId);
    const timestampSeconds = Number.parseInt(message.timestamp ?? "", 10);
    const timestamp = Number.isFinite(timestampSeconds)
      ? new Date(timestampSeconds * 1000)
      : new Date();

    return {
      channelId: senderId,
      isThreadReply: false,
      messageId,
      metadata: {
        channelType: "im",
        displayPhoneNumber: value?.metadata?.display_phone_number,
        messageType: message.type,
        phoneNumberId,
      },
      rawText: message.text.body,
      senderId,
      senderName: contact?.profile?.name || senderId,
      text: message.text.body,
      timestamp,
      workspaceId: entry?.id ?? this.config.businessAccountId,
    };
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    const response = await fetch(this.messagesEndpoint(), {
      body: JSON.stringify({
        messaging_product: "whatsapp",
        text: {
          body: options.text,
          preview_url: false,
        },
        to: options.originalMessage.channelId,
        type: "text",
      }),
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
      messages?: Array<{ id?: string }>;
    };

    if (!response.ok) {
      throw new Error(
        body.error?.message || `WhatsApp Graph API returned ${response.status}`,
      );
    }

    return body.messages?.[0]?.id ?? "";
  }

  async addApprovalRequestForm(
    options: AddApprovalRequestFormOptions,
  ): Promise<void> {
    await this.sendReply({
      originalMessage: options.originalMessage,
      text: `Approval required for ${options.toolName}. Reply outside WhatsApp to approve or decline.`,
    });
  }

  async updateApprovalRequest(
    _options: UpdateApprovalRequestOptions,
  ): Promise<void> {}

  async getThreadHistory(
    _params: ThreadHistoryParams,
  ): Promise<ChatThreadMessage[]> {
    return [];
  }

  async getUserEmail(_userId: string): Promise<string | null> {
    const senderPhone = normalizePhoneNumber(_userId);
    if (!senderPhone) return null;

    const mapping = this.config.phoneUserMappings?.find(
      (item) => normalizePhoneNumber(item.phoneNumber) === senderPhone,
    );
    return mapping?.email.trim().toLowerCase() ?? null;
  }

  async getChannelName(_channelId: string): Promise<string | null> {
    return null;
  }

  parseInteractivePayload(_payload: unknown): null {
    return null;
  }

  async sendAgentSelectionCard(params: {
    message: IncomingChatMessage;
    agents: { id: string; name: string }[];
    isWelcome: boolean;
    providerContext?: unknown;
  }): Promise<void> {
    const agentList =
      params.agents.map((agent) => `- ${agent.name}`).join("\n") ||
      "No agents are available.";
    await this.sendReply({
      originalMessage: params.message,
      text: `${params.isWelcome ? "Choose an agent to start:" : "Available agents:"}\n${agentList}`,
    });
  }

  getWorkspaceId(): string | null {
    return this.config.businessAccountId || null;
  }

  getWorkspaceName(): string | null {
    return null;
  }

  hasMissingScopes(): boolean {
    return false;
  }

  async notifyMissingScopes(_message: IncomingChatMessage): Promise<void> {}

  async downloadFiles(
    _files: ChatThreadMessageFile[],
  ): Promise<NonNullable<IncomingChatMessage["attachments"]>> {
    return [];
  }

  async discoverChannels(
    _context: unknown,
  ): Promise<DiscoveredChannel[] | null> {
    return null;
  }

  private messagesEndpoint(): string {
    const version = this.config.graphApiVersion || "v21.0";
    return `https://graph.facebook.com/${version}/${this.config.phoneNumberId}/messages`;
  }
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function normalizePhoneNumber(value: string): string {
  return value.replace(/\D/g, "");
}

export default WhatsAppProvider;
