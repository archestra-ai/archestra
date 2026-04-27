import logger from "@/logging";
import type {
  ChatOpsProvider,
  ChatOpsProviderType,
  ChatReplyOptions,
  ChatThreadMessage,
  DiscoveredChannel,
  IncomingChatMessage,
  TelegramDbConfig,
  ThreadHistoryParams,
} from "@/types/chatops";

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
    is_bot?: boolean;
  };
  chat: {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
    title?: string;
    username?: string;
  };
  date: number;
  text?: string;
  message_thread_id?: number;
  reply_to_message?: {
    message_id: number;
  };
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
  }>;
}

export class TelegramProvider implements ChatOpsProvider {
  readonly providerId: ChatOpsProviderType = "telegram";
  readonly displayName = "Telegram";

  private config: TelegramDbConfig;
  private botInfo: { id: number; username: string } | null = null;

  constructor(config: TelegramDbConfig) {
    this.config = config;
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.enabled && this.config.botToken && this.config.secretToken,
    );
  }

  async initialize(): Promise<void> {
    try {
      const res = await this.callApi("getMe", {});
      if (res.ok) {
        const result = res.result as { id: number; username: string };
        this.botInfo = {
          id: result.id,
          username: result.username,
        };
        logger.info(
          { username: this.botInfo.username },
          "[TelegramProvider] Initialized",
        );
      }
    } catch (error) {
      logger.error({ error }, "[TelegramProvider] Failed to initialize");
    }
  }

  async cleanup(): Promise<void> {
    this.botInfo = null;
  }

  async validateWebhookRequest(
    _payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    const incoming = Array.isArray(headers["x-telegram-bot-api-secret-token"])
      ? headers["x-telegram-bot-api-secret-token"][0]
      : headers["x-telegram-bot-api-secret-token"];

    if (!incoming) {
      logger.warn("[TelegramProvider] Missing secret token header");
      return false;
    }

    const valid = incoming === this.config.secretToken;
    if (!valid) {
      logger.warn("[TelegramProvider] Invalid secret token");
    }
    return valid;
  }

  handleValidationChallenge(_payload: unknown): null {
    // Telegram has no URL verification challenge
    return null;
  }

  async parseWebhookNotification(
    payload: unknown,
    _headers: Record<string, string | string[] | undefined>,
  ): Promise<IncomingChatMessage | null> {
    const update = payload as TelegramUpdate;
    const msg = update.message;

    if (!msg || !msg.text) return null;

    // Skip bot messages
    if (msg.from?.is_bot) return null;

    const isPrivate = msg.chat.type === "private";
    const botUsername = this.botInfo?.username;

    // In groups require @mention  same gate as Slack's isDM check
    if (!isPrivate) {
      const mentioned =
        botUsername &&
        msg.entities?.some((e) => e.type === "mention") &&
        msg.text.includes(`@${botUsername}`);
      if (!mentioned) return null;
    }

    const cleanedText = botUsername
      ? msg.text.replace(`@${botUsername}`, "").trim()
      : msg.text.trim();

    if (!cleanedText) return null;

    const senderId = String(msg.from?.id ?? "unknown");
    const senderName =
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") ||
      msg.from?.username ||
      "Unknown User";

    const threadId = String(msg.message_thread_id ?? msg.message_id);

    return {
      messageId: String(msg.message_id),
      channelId: String(msg.chat.id),
      workspaceId: null,
      threadId,
      senderId,
      senderName,
      // Telegram has no email  use sender ID as identifier
      senderEmail: undefined,
      text: cleanedText,
      rawText: msg.text,
      timestamp: new Date(msg.date * 1000),
      isThreadReply: Boolean(msg.reply_to_message),
      metadata: {
        chatType: msg.chat.type,
        telegramUserId: senderId,
      },
    };
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    const text = options.footer ? `${options.text}\n\n${options.footer}` : options.text;

    const result = await this.callApi("sendMessage", {
      chat_id: options.originalMessage.channelId,
      text,
      reply_to_message_id: Number(options.originalMessage.threadId),
      parse_mode: "Markdown",
    });

    return String(result.result?.message_id ?? "");
  }

  async getUserEmail(_userId: string): Promise<string | null> {
    // Telegram does not expose email addresses
    return null;
  }

  async getUserName(userId: string): Promise<string | null> {
    // Username is captured from the incoming message
    // Cannot look up arbitrary users without a shared chat
    return userId;
  }

  async getChannelName(channelId: string): Promise<string | null> {
    try {
      const res = await this.callApi("getChat", {
        chat_id: channelId,
      });
      const title = res.result?.title;
      const username = res.result?.username;
      if (typeof title === "string") return title;
      if (typeof username === "string") return username;
      return null;
    } catch {
      return null;
    }
  }

  async getThreadHistory(_params: ThreadHistoryParams): Promise<ChatThreadMessage[]> {
    // Telegram Bot API does not expose message history
    return [];
  }

  parseInteractivePayload(_payload: unknown): null {
    // Interactive payloads (inline keyboards) not in v1 scope
    return null;
  }

  async sendAgentSelectionCard(params: {
    message: IncomingChatMessage;
    agents: { id: string; name: string }[];
    isWelcome: boolean;
  }): Promise<void> {
    const lines = params.agents.map((a, i) => `${i + 1}. ${a.name}`);
    const header = params.isWelcome
      ? "Welcome! Please choose an agent:"
      : "Choose an agent:";
    const text = [header, ...lines].join("\n");

    await this.callApi("sendMessage", {
      chat_id: params.message.channelId,
      text,
    });
  }

  getWorkspaceId(): null {
    return null;
  }

  getWorkspaceName(): null {
    return null;
  }

  hasMissingScopes(): boolean {
    return false;
  }

  async notifyMissingScopes(_message: IncomingChatMessage): Promise<void> {}

  async downloadFiles(): Promise<[]> {
    return [];
  }

  async discoverChannels(_context: unknown): Promise<DiscoveredChannel[] | null> {
    return null;
  }

  //  Private helpers

  private async callApi(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      throw new Error(`Telegram API error: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<{
      ok: boolean;
      result: Record<string, unknown>;
    }>;
  }
}
