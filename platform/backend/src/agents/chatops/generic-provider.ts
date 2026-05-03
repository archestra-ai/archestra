import { createHash, randomUUID } from "node:crypto";
import type { A2AAttachment } from "@/agents/a2a-executor";
import logger from "@/logging";
import { ChatOpsExternalIdMappingModel, UserModel } from "@/models";
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
  ThreadHistoryParams,
  UpdateApprovalRequestOptions,
} from "@/types";
import type {
  GenericAgentSelectionCallback,
  GenericHistoryMessage,
  GenericInteractiveEventRequest,
  GenericMessageEventRequest,
  GenericSendReplyCallback,
  GenericTypingCallback,
} from "@/types/chatops-generic";
import { errorMessage } from "./utils";

const REPLY_CONTEXT_TTL_MS = 15 * 60 * 1000;

interface ReplyContextEntry {
  replyContext: unknown;
  storedAt: number;
}

class GenericChatOpsProvider implements ChatOpsProvider {
  readonly providerId: ChatOpsProviderType = "generic";
  readonly displayName: string;

  private readonly adapterId: string;
  private readonly baseUrl: string;
  private readonly configWorkspaceId: string | null;
  private readonly configWorkspaceName: string | null;

  private readonly replyContextCache = new Map<string, ReplyContextEntry>();
  private readonly threadHistoryCache = new Map<
    string,
    GenericHistoryMessage[]
  >();
  private readonly channelCache = new Map<
    string,
    { name: string | null; workspaceId: string; workspaceName: string | null }
  >();
  private readonly senderNameCache = new Map<string, string>();
  private readonly senderExternalIdCache = new Map<string, string>();

  constructor(config: {
    adapterId: string;
    baseUrl: string;
    workspaceId?: string;
    workspaceName?: string;
    displayName?: string;
  }) {
    this.adapterId = config.adapterId;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.configWorkspaceId = config.workspaceId ?? null;
    this.configWorkspaceName = config.workspaceName ?? null;
    this.displayName = config.displayName ?? `Generic (${config.adapterId})`;
  }

  getAdapterId(): string {
    return this.adapterId;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  async initialize(): Promise<void> {
    logger.info(
      { adapterId: this.adapterId, baseUrl: this.baseUrl },
      "[GenericChatOps] Initialized",
    );
  }

  async cleanup(): Promise<void> {
    this.replyContextCache.clear();
    this.threadHistoryCache.clear();
    this.channelCache.clear();
    this.senderNameCache.clear();
    this.senderExternalIdCache.clear();
    this.eventHandler = null;
    logger.info({ adapterId: this.adapterId }, "[GenericChatOps] Cleaned up");
  }

  setEventHandler(handler: ChatOpsEventHandler): void {
    this.eventHandler = handler;
  }

  async validateWebhookRequest(
    _payload: unknown,
    _headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    return true;
  }

  handleValidationChallenge(_payload: unknown): unknown | null {
    return null;
  }

  async parseWebhookNotification(
    payload: unknown,
    _headers: Record<string, string | string[] | undefined>,
  ): Promise<IncomingChatMessage | null> {
    const body = payload as GenericMessageEventRequest;

    const namespacedMessageId = namespaceId(
      this.adapterId,
      "message",
      body.messageId,
    );
    const namespacedChannelId = namespaceId(
      this.adapterId,
      "channel",
      body.channel.externalId,
    );
    const namespacedWorkspaceId = body.workspace
      ? namespaceId(this.adapterId, "workspace", body.workspace.externalId)
      : null;
    const namespacedThreadId = body.thread
      ? namespaceId(this.adapterId, "thread", body.thread.externalId)
      : undefined;
    const namespacedSenderId = namespaceId(
      this.adapterId,
      "sender",
      body.sender.externalId,
    );

    if (body.replyContext !== undefined) {
      this.saveReplyContext(namespacedMessageId, body.replyContext);
    }

    if (body.threadHistory?.length) {
      this.threadHistoryCache.set(namespacedMessageId, body.threadHistory);
    }

    if (body.channel.name) {
      this.channelCache.set(namespacedChannelId, {
        name: body.channel.name,
        workspaceId:
          namespacedWorkspaceId ?? this.configWorkspaceId ?? "default",
        workspaceName: body.workspace?.name ?? this.configWorkspaceName,
      });
    }

    this.senderNameCache.set(namespacedSenderId, body.sender.name);
    this.senderExternalIdCache.set(namespacedSenderId, body.sender.externalId);

    return {
      messageId: namespacedMessageId,
      channelId: namespacedChannelId,
      workspaceId: namespacedWorkspaceId,
      threadId: namespacedThreadId,
      senderId: namespacedSenderId,
      senderName: body.sender.name,
      senderEmail: body.sender.email,
      text: body.text,
      rawText: body.rawText,
      timestamp: new Date(body.timestamp),
      isThreadReply: body.isThreadReply,
      metadata: {
        ...body.metadata,
        channelType: body.channel.kind === "dm" ? "im" : body.channel.kind,
        replyContext: body.replyContext,
      },
      ...(body.attachments?.length ? { attachments: body.attachments } : {}),
    };
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    const replyContext =
      this.getReplyContext(options.originalMessage.messageId) ??
      options.originalMessage.metadata?.replyContext ??
      null;
    const deliveryId = `delivery-${randomUUID()}`;

    const callbackBody: GenericSendReplyCallback = {
      schemaVersion: "v1",
      deliveryId,
      replyContext,
      text: options.text,
      ...(options.footer ? { footer: options.footer } : {}),
    };

    await this.postCallback("/reply", callbackBody);
    return deliveryId;
  }

  async addApprovalRequestForm(
    options: AddApprovalRequestFormOptions,
  ): Promise<void> {
    const replyContext =
      this.getReplyContext(options.originalMessage.messageId) ??
      options.originalMessage.metadata?.replyContext ??
      null;
    const deliveryId = `delivery-${randomUUID()}`;

    await this.postCallback("/reply", {
      schemaVersion: "v1",
      deliveryId,
      replyContext,
      text: `Approval Required for ${options.toolName}`,
      metadata: {
        approvalRequest: {
          taskId: options.taskId,
          approvalId: options.approvalId,
          toolName: options.toolName,
        },
      },
    });
  }

  async updateApprovalRequest(
    _options: UpdateApprovalRequestOptions,
  ): Promise<void> {}

  async sendAgentSelectionCard(params: {
    message: IncomingChatMessage;
    agents: { id: string; name: string }[];
    isWelcome: boolean;
    providerContext?: unknown;
  }): Promise<void> {
    const replyContext =
      this.getReplyContext(params.message.messageId) ??
      params.message.metadata?.replyContext ??
      null;
    const deliveryId = `delivery-${randomUUID()}`;

    const callbackBody: GenericAgentSelectionCallback = {
      schemaVersion: "v1",
      deliveryId,
      replyContext,
      isWelcome: params.isWelcome,
      agents: params.agents,
    };

    await this.postCallback("/agent-selection", callbackBody);
  }

  async getUserEmail(namespacedSenderId: string): Promise<string | null> {
    const externalId = this.senderExternalIdCache.get(namespacedSenderId);
    if (!externalId) return null;
    const mapping = await ChatOpsExternalIdMappingModel.findByExternalId(
      this.adapterId,
      externalId,
    );
    if (!mapping) return null;
    const user = await UserModel.getById(mapping.userId);
    return user?.email ?? null;
  }

  async getUserName(userId: string): Promise<string | null> {
    return this.senderNameCache.get(userId) ?? null;
  }

  async getThreadHistory(
    params: ThreadHistoryParams,
  ): Promise<ChatThreadMessage[]> {
    const history = params.excludeMessageId
      ? this.threadHistoryCache.get(params.excludeMessageId)
      : undefined;

    if (!history?.length) return [];

    return history.map((msg) => ({
      messageId: namespaceId(this.adapterId, "message", msg.messageId),
      senderId: namespaceId(this.adapterId, "sender", msg.senderId),
      senderName: msg.senderName,
      text: msg.text,
      timestamp: new Date(msg.timestamp),
      isFromBot: msg.isFromBot,
      ...(msg.files?.length
        ? {
            files: msg.files.map((f) => ({
              url: f.fileId,
              mimetype: f.mimeType,
              name: f.name,
              size: f.size,
            })),
          }
        : {}),
    }));
  }

  async downloadFiles(
    files: ChatThreadMessageFile[],
  ): Promise<A2AAttachment[]> {
    if (!files.length) return [];

    const deliveryId = `delivery-${randomUUID()}`;

    try {
      const response = await fetch(`${this.baseUrl}/attachments/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "v1",
          deliveryId,
          files: files.map((f) => ({
            fileId: f.url,
            mimeType: f.mimetype,
            name: f.name,
            size: f.size,
          })),
        }),
      });

      if (!response.ok) {
        logger.warn(
          { status: response.status, adapterId: this.adapterId },
          "[GenericChatOps] Failed to fetch attachments from adapter",
        );
        return [];
      }

      const result = (await response.json()) as {
        results: Array<{ fileId: string; attachment: A2AAttachment }>;
      };

      return result.results.map((r) => r.attachment);
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), adapterId: this.adapterId },
        "[GenericChatOps] Error fetching attachments",
      );
      return [];
    }
  }

  async discoverChannels(
    _context: unknown,
  ): Promise<DiscoveredChannel[] | null> {
    if (this.channelCache.size === 0) return null;

    return Array.from(this.channelCache.entries()).map(([channelId, info]) => ({
      channelId,
      channelName: info.name,
      workspaceId: info.workspaceId,
      workspaceName: info.workspaceName,
    }));
  }

  parseInteractivePayload(payload: unknown): {
    agentId: string;
    channelId: string;
    workspaceId: string | null;
    threadTs?: string;
    userId: string;
    userName: string;
    responseUrl: string;
  } | null {
    const body = payload as GenericInteractiveEventRequest;

    if (body.action !== "select-agent" || !body.agentId) {
      return null;
    }

    const namespacedChannelId = namespaceId(
      this.adapterId,
      "channel",
      body.channel.externalId,
    );
    const namespacedWorkspaceId = body.workspace
      ? namespaceId(this.adapterId, "workspace", body.workspace.externalId)
      : null;
    const namespacedThreadId = body.thread
      ? namespaceId(this.adapterId, "thread", body.thread.externalId)
      : undefined;
    const namespacedSenderId = namespaceId(
      this.adapterId,
      "sender",
      body.sender.externalId,
    );

    const channelKey = `channel:${namespacedChannelId}:${namespacedThreadId || ""}`;
    if (body.replyContext !== undefined) {
      this.saveReplyContext(channelKey, body.replyContext);
    }

    this.senderNameCache.set(namespacedSenderId, body.sender.name);

    return {
      agentId: body.agentId,
      channelId: namespacedChannelId,
      workspaceId: namespacedWorkspaceId,
      threadTs: namespacedThreadId,
      userId: namespacedSenderId,
      userName: body.sender.name,
      responseUrl: "",
    };
  }

  async setTypingStatus(
    _channelId: string,
    _threadTs: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const replyContext = metadata?.replyContext;
    if (!replyContext) return;

    const deliveryId = `delivery-${randomUUID()}`;

    const callbackBody: GenericTypingCallback = {
      schemaVersion: "v1",
      deliveryId,
      replyContext,
    };

    await this.postCallback("/typing", callbackBody).catch((error) => {
      logger.debug(
        { error: errorMessage(error), adapterId: this.adapterId },
        "[GenericChatOps] setTypingStatus failed (non-fatal)",
      );
    });
  }

  getWorkspaceId(): string | null {
    return this.configWorkspaceId;
  }

  getWorkspaceName(): string | null {
    return this.configWorkspaceName;
  }

  hasMissingScopes(): boolean {
    return false;
  }

  async notifyMissingScopes(_message: IncomingChatMessage): Promise<void> {}

  async getChannelName(channelId: string): Promise<string | null> {
    const cached = this.channelCache.get(channelId);
    return cached?.name ?? null;
  }

  syncChannels(
    channels: Array<{
      externalId: string;
      name: string | null;
      kind: string;
      dmOwnerEmail?: string | null;
      workspaceId?: string;
      workspaceName?: string | null;
    }>,
  ): void {
    this.channelCache.clear();
    for (const ch of channels) {
      const namespacedChannelId = namespaceId(
        this.adapterId,
        "channel",
        ch.externalId,
      );
      this.channelCache.set(namespacedChannelId, {
        name: ch.name,
        workspaceId: ch.workspaceId ?? this.configWorkspaceId ?? "default",
        workspaceName: ch.workspaceName ?? this.configWorkspaceName,
      });
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private saveReplyContext(key: string, replyContext: unknown): void {
    this.evictExpiredEntries();
    this.replyContextCache.set(key, {
      replyContext,
      storedAt: Date.now(),
    });
  }

  private getReplyContext(key: string): unknown | undefined {
    const entry = this.replyContextCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.storedAt > REPLY_CONTEXT_TTL_MS) {
      this.replyContextCache.delete(key);
      return undefined;
    }
    return entry.replyContext;
  }

  private evictExpiredEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.replyContextCache) {
      if (now - entry.storedAt > REPLY_CONTEXT_TTL_MS) {
        this.replyContextCache.delete(key);
      }
    }
  }

  private async postCallback(path: string, body: unknown): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Callback ${path} failed with status ${response.status}`);
    }
  }
}

function namespaceId(
  adapterId: string,
  kind: string,
  externalId: string,
): string {
  const hash = createHash("sha256")
    .update(externalId)
    .digest("hex")
    .slice(0, 16);
  return `generic:${adapterId}:${kind}:${hash}`;
}

export default GenericChatOpsProvider;
export { namespaceId };
