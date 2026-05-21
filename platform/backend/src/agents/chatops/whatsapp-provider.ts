import { existsSync, mkdirSync } from "node:fs";
import type { WAMessage } from "@whiskeysockets/baileys";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import type { A2AAttachment } from "@/agents/a2a-executor";
import logger from "@/logging";
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
  ThreadHistoryParams,
  UpdateApprovalRequestOptions,
  WhatsAppDbConfig,
} from "@/types";
import { errorMessage } from "./utils";

const WORKSPACE_ID = "whatsapp";

class WhatsAppProvider implements ChatOpsProvider {
  readonly providerId: ChatOpsProviderType = "whatsapp";
  readonly displayName = "WhatsApp";

  private config: WhatsAppDbConfig;
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private qrCode: string | null = null;
  private connectionStatus: "disconnected" | "connecting" | "connected" =
    "disconnected";
  private eventHandler: ChatOpsEventHandler | null = null;
  private store = makeInMemoryStore({});
  private pendingApprovals = new Map<
    string,
    { taskId: string; toolName: string; originalMessage: IncomingChatMessage }
  >();
  private reconnecting = false;
  private intentionalDisconnect = false;
  private sessionDir: string;

  constructor(config: WhatsAppDbConfig) {
    this.config = config;
    this.sessionDir = config.sessionDir ?? "./data/whatsapp-session";
  }

  // ===
  // Public helpers (not part of interface)
  // ===

  setEventHandler(handler: ChatOpsEventHandler): void {
    this.eventHandler = handler;
  }

  getQrCode(): string | null {
    return this.qrCode;
  }

  getConnectionStatus(): "disconnected" | "connecting" | "connected" {
    return this.connectionStatus;
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.reconnecting = false;
    await this.cleanup();
  }

  // ===
  // ChatOpsProvider interface
  // ===

  isConfigured(): boolean {
    return this.config.enabled;
  }

  async initialize(): Promise<void> {
    if (!this.isConfigured()) return;
    this.intentionalDisconnect = false;
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }
    await this.startSocket();
  }

  async cleanup(): Promise<void> {
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // ignore
      }
      this.sock = null;
    }
    this.qrCode = null;
    this.connectionStatus = "disconnected";
    this.pendingApprovals.clear();
    logger.info("[WhatsApp] Cleaned up");
  }

  async validateWebhookRequest(): Promise<boolean> {
    return true;
  }

  handleValidationChallenge(): null {
    return null;
  }

  async parseWebhookNotification(
    payload: unknown,
    _headers?: Record<string, string | string[] | undefined>,
  ): Promise<IncomingChatMessage | null> {
    const msg = payload as WAMessage;
    if (!msg?.key?.remoteJid || !msg.message) return null;

    const jid = msg.key.remoteJid;
    if (jid.endsWith("@g.us") || jid === "status@broadcast") return null;

    const text = extractText(msg);
    if (!text) return null;

    const phone = jidToPhone(jid);
    const senderEmail = (await this.getUserEmail(jid)) ?? undefined;
    const msgId = msg.key.id ?? `wa-${Date.now()}`;
    const ts = Number(msg.messageTimestamp ?? 0) * 1000;

    return {
      messageId: msgId,
      channelId: jid,
      workspaceId: WORKSPACE_ID,
      threadId: jid,
      senderId: jid,
      senderEmail,
      senderName: phone,
      text,
      rawText: text,
      timestamp: new Date(ts > 0 ? ts : Date.now()),
      isThreadReply: false,
      metadata: { channelType: "im" },
    };
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    if (!this.sock) throw new Error("[WhatsApp] Not connected");
    const sent = await this.sock.sendMessage(options.originalMessage.channelId, {
      text: options.text,
    });
    return sent?.key?.id ?? "";
  }

  async addApprovalRequestForm(
    options: AddApprovalRequestFormOptions,
  ): Promise<void> {
    if (!this.sock) return;
    const key = `${options.channelId}:${options.approvalId}`;
    this.pendingApprovals.set(key, {
      taskId: options.taskId,
      toolName: options.toolName,
      originalMessage: options.originalMessage,
    });
    await this.sock.sendMessage(options.channelId, {
      text: `🔔 *Approval required*\nTool: \`${options.toolName}\`\n\nReply *approve* ✅ or *decline* ❌`,
    });
  }

  async updateApprovalRequest(
    options: UpdateApprovalRequestOptions,
  ): Promise<void> {
    if (!this.sock) return;
    const status = options.approved ? "✅ Approved" : "❌ Declined";
    await this.sock.sendMessage(options.channelId, {
      text: `\`${options.toolName}\`: ${status}`,
    });
  }

  async sendEphemeralMessage(params: {
    channelId: string;
    userId: string;
    text: string;
    threadId?: string;
  }): Promise<void> {
    if (!this.sock) return;
    await this.sock.sendMessage(params.channelId, { text: params.text });
  }

  async sendDirectMessage(params: {
    userId: string;
    text: string;
    channelId?: string;
  }): Promise<void> {
    if (!this.sock) return;
    const jid = params.channelId ?? params.userId;
    await this.sock.sendMessage(jid, { text: params.text });
  }

  async handleInteractivePayload(): Promise<void> {
    // WhatsApp has no button payloads; approvals are handled via text in handleRawMessage
  }

  async setTypingStatus(): Promise<void> {
    // WhatsApp supports presence updates via Baileys but it's optional
  }

  async getThreadHistory(params: ThreadHistoryParams): Promise<ChatThreadMessage[]> {
    const msgs = this.store.messages[params.threadId]?.array ?? [];
    const limit = params.limit ?? 50;
    return msgs
      .slice(-limit)
      .flatMap((m: WAMessage) => {
        const text = extractText(m);
        if (!text) return [];
        return [
          {
            messageId: m.key.id ?? "",
            senderId: m.key.remoteJid ?? "",
            senderName: m.key.fromMe ? "Bot" : jidToPhone(m.key.remoteJid ?? ""),
            text,
            timestamp: new Date(Number(m.messageTimestamp ?? 0) * 1000),
            isFromBot: m.key.fromMe ?? false,
          } satisfies ChatThreadMessage,
        ];
      });
  }

  async getUserEmail(userId: string): Promise<string | null> {
    const phone = jidToPhone(userId);
    return (
      this.config.phoneEmailMappings?.find((m) => m.phone === phone)?.email ??
      null
    );
  }

  async getUserName(userId: string): Promise<string | null> {
    return `+${jidToPhone(userId)}`;
  }

  async getChannelName(channelId: string): Promise<string | null> {
    return `+${jidToPhone(channelId)}`;
  }

  parseInteractivePayload(): null {
    return null;
  }

  async sendAgentSelectionCard(params: {
    message: IncomingChatMessage;
    agents: { id: string; name: string }[];
    isWelcome: boolean;
  }): Promise<void> {
    if (!this.sock) return;
    const header = params.isWelcome
      ? "👋 Welcome! Select an agent to get started:"
      : "Select an agent:";
    const lines = [
      header,
      ...params.agents.map((a, i) => `${i + 1}. ${a.name}`),
      "",
      "Tip: Use *AgentName > your message* to talk to a specific agent.",
    ];
    await this.sock.sendMessage(params.message.channelId, {
      text: lines.join("\n"),
    });
  }

  getWorkspaceId(): string {
    return WORKSPACE_ID;
  }

  getWorkspaceName(): string {
    return "WhatsApp";
  }

  hasMissingScopes(): boolean {
    return false;
  }

  async notifyMissingScopes(): Promise<void> {
    // no-op
  }

  async downloadFiles(files: ChatThreadMessageFile[]): Promise<A2AAttachment[]> {
    const results: A2AAttachment[] = [];
    for (const file of files) {
      try {
        const resp = await fetch(file.url);
        const buffer = await resp.arrayBuffer();
        results.push({
          contentType: file.mimetype ?? "application/octet-stream",
          contentBase64: Buffer.from(buffer).toString("base64"),
          name: file.name,
        });
      } catch (error) {
        logger.warn(
          { url: file.url, error: errorMessage(error) },
          "[WhatsApp] Failed to download file",
        );
      }
    }
    return results;
  }

  async discoverChannels(): Promise<DiscoveredChannel[] | null> {
    return [];
  }

  // ===
  // Private helpers
  // ===

  private async startSocket(): Promise<void> {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
      });

      this.store.bind(this.sock.ev);

      this.sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            const QRCode = await import("qrcode");
            this.qrCode = await QRCode.toDataURL(qr);
          } catch {
            this.qrCode = qr;
          }
          this.connectionStatus = "connecting";
          logger.info("[WhatsApp] QR code ready — scan to connect");
        }

        if (connection === "open") {
          this.qrCode = null;
          this.connectionStatus = "connected";
          logger.info("[WhatsApp] Connected");
        }

        if (connection === "close") {
          this.connectionStatus = "disconnected";
          const statusCode = (
            lastDisconnect?.error as
              | { output?: { statusCode?: number } }
              | undefined
          )?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          logger.info(
            { statusCode, shouldReconnect },
            "[WhatsApp] Connection closed",
          );
          if (shouldReconnect && !this.reconnecting && !this.intentionalDisconnect) {
            this.reconnecting = true;
            await this.startSocket();
            this.reconnecting = false;
          }
        }
      });

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
          if (!msg.message) continue;
          if (msg.key.fromMe) continue;
          await this.handleRawMessage(msg);
        }
      });
    } catch (error) {
      logger.error(
        { error: errorMessage(error) },
        "[WhatsApp] Failed to start socket",
      );
      throw error;
    }
  }

  private async handleRawMessage(msg: WAMessage): Promise<void> {
    if (!this.eventHandler) return;

    const jid = msg.key.remoteJid;
    if (!jid) return;
    if (jid.endsWith("@g.us") || jid === "status@broadcast") return;

    const text = extractText(msg)?.trim().toLowerCase();
    if (!text) return;

    // Check for a pending HITL approval reply
    const approvalKey = this.findPendingApproval(jid);
    if (
      approvalKey &&
      (text === "approve" || text === "✅" || text === "decline" || text === "❌")
    ) {
      const approval = this.pendingApprovals.get(approvalKey);
      if (approval) {
        this.pendingApprovals.delete(approvalKey);
        const approved = text === "approve" || text === "✅";
        const parsed = await this.parseWebhookNotification(msg);
        if (!parsed) return;
        const decision: ChatOpsApprovalDecision = {
          taskId: approval.taskId,
          approvalId: approvalKey.split(":").slice(1).join(":"),
          approved,
          toolName: approval.toolName,
          messageTs: String(msg.messageTimestamp ?? Date.now()),
          channelId: jid,
          workspaceId: WORKSPACE_ID,
          originalMessage: approval.originalMessage,
          userId: jid,
          userName: jidToPhone(jid),
          responseUrl: "",
        };
        await this.eventHandler.handleInteractiveApprovalDecision(
          this,
          decision,
        );
        return;
      }
    }

    await this.eventHandler.handleIncomingMessage(this, msg);
  }

  private findPendingApproval(jid: string): string | undefined {
    for (const key of this.pendingApprovals.keys()) {
      if (key.startsWith(`${jid}:`)) return key;
    }
    return undefined;
  }
}

export default WhatsAppProvider;

// ===
// Internal helpers
// ===

function jidToPhone(jid: string): string {
  return jid.replace(/@s\.whatsapp\.net$/, "").replace(/@g\.us$/, "");
}

function extractText(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    null
  );
}
