import { createHash } from "node:crypto";
import {
  ChatErrorCode,
  type ChatErrorResponse,
  providerDisplayNames,
  type ResourceVisibilityScope,
} from "@archestra/shared";
import type { UIMessage } from "ai";
import {
  A2AManager,
  type A2ASendMessageResult,
} from "@/agents/a2a/a2a-manager";
import type { A2AAttachment } from "@/agents/a2a-executor";
import { resolveRunToolTarget } from "@/archestra-mcp-server/run-tool-target";
import { userHasPermission } from "@/auth/utils";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import {
  ActiveChatRunModel,
  AgentModel,
  AgentTeamModel,
  ChatOpsChannelBindingModel,
  ChatOpsConfigModel,
  ChatOpsProcessedMessageModel,
  ChatOpsThreadAgentOverrideModel,
  ChatOpsThreadConversationModel,
  ConversationModel,
  LlmProviderApiKeyModel,
  MessageModel,
  OrganizationModel,
  TeamModel,
  UserModel,
} from "@/models";
import { RouteCategory } from "@/observability/tracing";
import { ProviderError } from "@/routes/chat/errors";
import {
  collectProviderMessageIds,
  filterHistoryForChatOpsContext,
  ingestProviderDelta,
  persistChatOpsAssistantTurn,
  persistChatOpsUserTurn,
  recordChatOpsConversationError,
  resolveOrCreateThreadConversation,
} from "@/services/chatops-conversation";
import type {
  ChatMessage,
  ChatOpsApprovalDecision,
  ChatOpsConnectionMode,
  ChatOpsProcessingResult,
  ChatOpsProvider,
  ChatOpsProviderType,
  ChatThreadMessage,
  IncomingChatMessage,
  SkippedAttachment,
} from "@/types";
import { LlmProviderAuthRequiredError } from "@/utils/llm-provider-auth-error";
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";
import { stripThinkingBlocks } from "@/utils/strip-thinking-blocks";
import type { InteractionSource } from "../../../../shared";
import {
  buildApprovalDecisionSendMessageRequest,
  buildAttachmentsMessageParts,
  buildSendMessageRequest,
  extractApprovalRequestsFromSendMessageResult,
  extractMessageFromSendMessageResult,
} from "../a2a/a2a-helper";
import type {
  A2AArchestraApprovalRequest,
  A2AProtocolSendMessageResponse,
} from "../a2a/a2a-protocol";
import {
  buildWelcomeMessage,
  ensureProvisionedUser,
  isSsoConfigured,
} from "./auto-provision";
import { claimThreadMuteHint } from "./channel-activation";
import {
  CHATOPS_ATTACHMENT_LIMITS,
  CHATOPS_CHANNEL_DISCOVERY,
  CHATOPS_MESSAGE_RETENTION,
  CHATOPS_NO_REPLY_SENTINEL,
  SLACK_DEFAULT_CONNECTION_MODE,
  THREAD_MUTE_HINT,
} from "./constants";
import MSTeamsProvider from "./ms-teams-provider";
import SlackProvider from "./slack-provider";
import TelegramProvider from "./telegram-provider";
import {
  buildAgentFooter,
  buildHistorySkippedAttachmentsNote,
  buildSkippedAttachmentsNote,
  errorMessage,
  isLlmProviderAuthError,
  isSlackDmChannel,
} from "./utils";

/**
 * ChatOps Manager - handles chatops provider lifecycle and message processing
 * @public — exported for testability
 */
export class ChatOpsManager {
  private msTeamsProvider: MSTeamsProvider | null = null;
  private slackProvider: SlackProvider | null = null;
  private telegramProvider: TelegramProvider | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly a2aManager: A2AManager;

  constructor() {
    this.a2aManager = new A2AManager({
      stateless: true,
    });
  }

  getMSTeamsProvider(): MSTeamsProvider | null {
    return this.msTeamsProvider;
  }

  getSlackProvider(): SlackProvider | null {
    return this.slackProvider;
  }

  getTelegramProvider(): TelegramProvider | null {
    return this.telegramProvider;
  }

  getChatOpsProvider(
    providerType: ChatOpsProviderType,
  ): ChatOpsProvider | null {
    switch (providerType) {
      case "ms-teams":
        return this.getMSTeamsProvider();
      case "slack":
        return this.getSlackProvider();
      case "telegram":
        return this.getTelegramProvider();
    }
  }

  /**
   * Get agents available for a chatops provider, filtered by user access.
   * If senderEmail is provided and resolves to a user, only returns agents
   * the user has team-based access to. Falls back to all agents if user
   * cannot be resolved (access check still happens at message processing time).
   *
   * When isDm=true, includes the user's own personal agents.
   * When isDm=false (default), excludes all personal agents since channels are shared.
   */
  async getAccessibleChatopsAgents({
    senderEmail,
    isDm,
  }: {
    senderEmail?: string;
    isDm: boolean;
  }): Promise<{ id: string; name: string }[]> {
    const user = senderEmail
      ? await UserModel.findByEmail(senderEmail.toLowerCase())
      : null;

    // For DMs with a known user, include that user's personal agents
    const agents =
      isDm && user
        ? await AgentModel.findAllInternalAgentsIncludingPersonal(user.id)
        : await AgentModel.findAllInternalAgents();

    if (!user || agents.length === 0) {
      return agents;
    }

    const org = await OrganizationModel.getFirst();
    if (!org) {
      return agents;
    }

    const isAgentAdmin = await userHasPermission(
      user.id,
      org.id,
      "agent",
      "admin",
    );
    const accessibleIds = await AgentTeamModel.getUserAccessibleAgentIds(
      user.id,
      isAgentAdmin,
    );
    const accessibleSet = new Set(accessibleIds);
    return agents.filter((a) => accessibleSet.has(a.id));
  }

  /**
   * Check if any chatops provider is configured and enabled.
   */
  isAnyProviderConfigured(): boolean {
    return (
      (this.msTeamsProvider?.isConfigured() ?? false) ||
      (this.slackProvider?.isConfigured() ?? false) ||
      (this.telegramProvider?.isConfigured() ?? false)
    );
  }

  /**
   * Discover all channels in a workspace and upsert them as bindings.
   * Uses a distributed TTL cache to avoid rediscovering too frequently.
   * Providers implement channel listing; this method handles caching, upsert, and stale cleanup.
   */
  async discoverChannels(params: {
    provider: ChatOpsProvider;
    context: unknown;
    workspaceId: string;
    /** Additional workspace ID variants for the same team (e.g. both aadGroupId and thread ID). */
    allWorkspaceIds?: string[];
  }): Promise<void> {
    const { provider, context, workspaceId } = params;

    // TTL check using distributed (PostgreSQL-backed) cache — shared across pods
    const cacheKey =
      `${CacheKey.ChannelDiscovery}-${provider.providerId}-${workspaceId}` as AllowedCacheKey;
    if (await cacheManager.get(cacheKey)) return;

    try {
      const channels = await provider.discoverChannels(context);
      if (!channels?.length) {
        logger.debug(
          { workspaceId },
          "[ChatOps] No channels returned by provider",
        );
        return;
      }

      const organizationId = await getDefaultOrganizationId();
      const activeChannelIds = channels.map((ch) => ch.channelId);

      // Upsert discovered channels (creates with agentId=null, updates names for existing)
      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId,
        provider: provider.providerId,
        channels,
      });

      // Remove bindings for channels that no longer exist.
      // Use all known workspace ID variants (UUID aadGroupId + thread ID) so stale
      // bindings are cleaned up regardless of which format was used when they were created.
      const workspaceIds = params.allWorkspaceIds?.length
        ? params.allWorkspaceIds
        : [workspaceId];
      const deletedCount = await ChatOpsChannelBindingModel.deleteStaleChannels(
        {
          organizationId,
          provider: provider.providerId,
          workspaceIds,
          activeChannelIds,
        },
      );

      // Clean up duplicate bindings for the same channel caused by different
      // workspaceId formats (UUID vs thread ID) stored at different times.
      await ChatOpsChannelBindingModel.deduplicateBindings({
        provider: provider.providerId,
        channelIds: activeChannelIds,
      });

      // Set TTL cache only after successful discovery
      await cacheManager.set(cacheKey, true, CHATOPS_CHANNEL_DISCOVERY.TTL_MS);

      logger.info(
        { workspaceId, channelCount: channels.length, deletedCount },
        "[ChatOps] Discovered channels",
      );
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "[ChatOps] Failed to discover channels",
      );
    }
  }

  async initialize(): Promise<void> {
    // Seed DB from env vars on first run (no-op if DB already has config)
    await this.seedConfigFromEnvVars();

    // Load configs from DB (the single source of truth)
    // Errors are caught individually so a single broken config doesn't prevent other providers from initializing
    const [msTeamsConfig, slackConfig, telegramConfig] = await Promise.all([
      ChatOpsConfigModel.getMsTeamsConfig().catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "[ChatOps] Failed to load MS Teams config, skipping",
        );
        return null;
      }),
      ChatOpsConfigModel.getSlackConfig().catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "[ChatOps] Failed to load Slack config, skipping",
        );
        return null;
      }),
      ChatOpsConfigModel.getTelegramConfig().catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "[ChatOps] Failed to load Telegram config, skipping",
        );
        return null;
      }),
    ]);

    // Create providers with their config
    if (msTeamsConfig) {
      this.msTeamsProvider = new MSTeamsProvider(msTeamsConfig);
      this.msTeamsProvider.setEventHandler(this);
    }
    if (slackConfig) {
      this.slackProvider = new SlackProvider(slackConfig);
      // Wire event handler so the provider can dispatch socket events and
      // access manager capabilities (e.g., getAccessibleChatopsAgents for slash commands)
      this.slackProvider.setEventHandler(this);
    }
    // The Telegram integration is feature-flagged: without the master switch
    // the provider never starts, even if the DB already holds a config.
    if (telegramConfig && config.chatops.telegramEnabled) {
      this.telegramProvider = new TelegramProvider(telegramConfig);
      // Telegram delivers everything over long polling, so all events flow
      // through the event handler (like Slack socket mode)
      this.telegramProvider.setEventHandler(this);
    }

    if (!this.isAnyProviderConfigured()) {
      return;
    }

    const providers: { name: string; provider: ChatOpsProvider | null }[] = [
      { name: "MS Teams", provider: this.msTeamsProvider },
      { name: "Slack", provider: this.slackProvider },
      { name: "Telegram", provider: this.telegramProvider },
    ];

    for (const { name, provider } of providers) {
      if (provider?.isConfigured()) {
        try {
          await provider.initialize();
          logger.info(`[ChatOps] ${name} provider initialized`);
        } catch (error) {
          logger.error(
            { error: errorMessage(error) },
            `[ChatOps] Failed to initialize ${name} provider`,
          );
        }
      }
    }

    // Eager channel discovery for providers that support it (fire-and-forget).
    // Providers that can determine their workspace ID without an incoming message
    // (e.g., Slack via auth.test) get channels discovered immediately on startup.
    for (const { name, provider } of providers) {
      const workspaceId = provider?.getWorkspaceId();
      if (provider && workspaceId) {
        this.discoverChannels({
          provider,
          context: null,
          workspaceId,
        }).catch((error) => {
          logger.warn(
            { error: errorMessage(error) },
            `[ChatOps] Initial ${name} channel discovery failed`,
          );
        });
      }
    }

    this.startProcessedMessageCleanup();
  }

  async reinitialize(): Promise<void> {
    await this.cleanup();
    await this.initialize();
  }

  async cleanup(): Promise<void> {
    if (this.msTeamsProvider) {
      await this.msTeamsProvider.cleanup();
      this.msTeamsProvider = null;
    }
    if (this.slackProvider) {
      await this.slackProvider.cleanup();
      this.slackProvider = null;
    }
    if (this.telegramProvider) {
      await this.telegramProvider.cleanup();
      this.telegramProvider = null;
    }
    this.stopCleanupInterval();
  }

  stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Handle an incoming message event from any provider.
   * Covers: channel discovery, email resolution, user verification,
   * binding check, agent selection or processMessage().
   */
  async handleIncomingMessage(
    provider: ChatOpsProvider,
    body: unknown,
  ): Promise<void> {
    const headers: Record<string, string | string[] | undefined> = {};
    const message = await provider.parseWebhookNotification(body, headers);
    if (!message) return;

    // Notify about missing scopes (rate-limited, at most once per 30 days)
    if (provider.hasMissingScopes()) {
      provider.notifyMissingScopes(message).catch(() => {});
    }

    // Discover channels in background
    if (message.workspaceId) {
      this.discoverChannels({
        provider,
        context: null,
        workspaceId: message.workspaceId,
      }).catch(() => {});
    }

    // Resolve sender email
    const senderEmail = await provider.getUserEmail(message.senderId);
    if (senderEmail) {
      message.senderEmail = senderEmail;
    }

    // Verify sender is a registered user
    if (!message.senderEmail) {
      logger.warn("[ChatOps] Could not resolve user email");
      await provider.sendReply({
        originalMessage: message,
        text:
          provider.identityVerificationFailureText?.() ??
          "Could not verify your identity. Please ensure your profile has an email configured.",
      });
      return;
    }

    let displayName = "";
    const provisioned = await ensureProvisionedUser({
      email: message.senderEmail,
      // Resolve display name from provider (e.g., Slack real_name)
      resolveDisplayName: async () => {
        displayName =
          (await provider.getUserName?.(message.senderId)) ||
          message.senderName;
        return displayName;
      },
      provider: provider.providerId,
    });
    if (!provisioned) {
      logger.error(
        { email: message.senderEmail },
        "[ChatOps] Auto-provisioned user not found after creation",
      );
      return;
    }
    if (provisioned.invitationId !== null) {
      // Send ephemeral welcome message (non-blocking)
      this.sendAutoProvisionWelcome({
        provider,
        message,
        invitationId: provisioned.invitationId,
        displayName,
      }).catch(() => {});
    }

    // Check for existing binding
    let binding = await ChatOpsChannelBindingModel.findByChannel({
      provider: provider.providerId,
      channelId: message.channelId,
      workspaceId: message.workspaceId,
    });

    // If no binding found and this is a DM, check for a pending DM binding
    // (pre-assigned from the UI before the first real DM interaction)
    const isDm = message.metadata?.channelType === "im";
    if (!binding && isDm && message.senderEmail) {
      const pending = await ChatOpsChannelBindingModel.findPendingDmBinding(
        provider.providerId,
        message.senderEmail,
      );
      if (pending) {
        binding = await ChatOpsChannelBindingModel.fulfillDmBinding(
          pending.id,
          message.channelId,
          message.workspaceId,
        );
        logger.info(
          { bindingId: pending.id, channelId: message.channelId },
          "[ChatOps] Fulfilled pending DM binding with real channel ID",
        );
      }
    }

    // Fallback: if the DM channel ID changed (e.g., after bot reinstallation),
    // the pending lookup above misses. Try to find an existing DM binding by
    // email and update its channelId to the new one, preserving the agentId.
    if (!binding && isDm && message.senderEmail) {
      const existingDm = await ChatOpsChannelBindingModel.findDmBindingByEmail(
        provider.providerId,
        message.senderEmail,
      );
      if (existingDm) {
        binding = await ChatOpsChannelBindingModel.fulfillDmBinding(
          existingDm.id,
          message.channelId,
          message.workspaceId,
        );
        logger.info(
          { bindingId: existingDm.id, channelId: message.channelId },
          "[ChatOps] Updated existing DM binding with new channel ID",
        );
      }
    }

    if (!binding || !binding.agentId) {
      // Create binding early (without agent) so the DM/channel appears in the UI
      if (!binding) {
        const channelName = isDm
          ? `Direct Message - ${message.senderEmail}`
          : await provider.getChannelName(message.channelId);
        const organizationId = await getDefaultOrganizationId();
        binding = await ChatOpsChannelBindingModel.upsertByChannel({
          organizationId,
          provider: provider.providerId,
          channelId: message.channelId,
          workspaceId: message.workspaceId,
          workspaceName: provider.getWorkspaceName() ?? undefined,
          channelName: channelName ?? undefined,
          isDm,
          dmOwnerEmail: isDm ? message.senderEmail : undefined,
        });
      }

      // Frictionless onboarding: auto-assign a clear default agent instead of
      // always prompting, so the bot just replies. Falls back to the picker
      // card only when the choice is ambiguous.
      const agentId = await this.resolveOrPromptChannelAgent({
        provider,
        message,
        binding,
        isDm,
      });
      if (!agentId) return; // picker card was sent
      binding = { ...binding, agentId };
    }

    // Always reply to empty Slack app mentions so users get a response even
    // when they only tag the bot without additional text.
    const isEmptySlackAppMention =
      provider.providerId === "slack" &&
      message.metadata?.eventType === "app_mention" &&
      !message.text.trim();
    if (isEmptySlackAppMention) {
      // Deduplicate this early-return path so Slack retries don't produce duplicate replies.
      const isNew = await ChatOpsProcessedMessageModel.tryMarkAsProcessed(
        message.messageId,
      );
      if (isNew) {
        await provider.sendReply({
          originalMessage: message,
          text: "How can I help you?",
        });
      }
      return;
    }

    // Process message through assigned agent
    await this.processMessage({
      message,
      provider,
      sendReply: true,
    });
  }

  /**
   * Handle an interactive payload (e.g. agent selection button click) from any provider.
   * Covers: parse selection, verify user, verify agent, upsert binding, confirm.
   */
  async handleInteractiveSelection(
    provider: ChatOpsProvider,
    payload: unknown,
  ): Promise<void> {
    const selection = provider.parseInteractivePayload(payload);
    if (!selection) return;

    // Verify the user clicking the button is a registered Archestra user
    const senderEmail = await provider.getUserEmail(selection.userId);
    if (!senderEmail) {
      logger.warn("[ChatOps] Could not resolve interactive user email");
      return;
    }
    // Auto-provision: create user + member from interactive payload
    const provisioned = await ensureProvisionedUser({
      email: senderEmail,
      resolveDisplayName: async () =>
        (await provider.getUserName?.(selection.userId)) || selection.userName,
      provider: provider.providerId,
    });
    if (!provisioned) {
      logger.error(
        { senderEmail },
        "[ChatOps] Auto-provisioned user not found after creation",
      );
      return;
    }

    // Verify agent exists
    const agent = await AgentModel.findById(selection.agentId);
    if (!agent) return;

    const organizationId = await getDefaultOrganizationId();

    // Create or update binding
    const isDm = selection.isDm ?? isSlackDmChannel(selection.channelId);
    const channelName = isDm
      ? `Direct Message - ${senderEmail}`
      : await provider.getChannelName(selection.channelId);
    await ChatOpsChannelBindingModel.upsertByChannel({
      organizationId,
      provider: provider.providerId,
      channelId: selection.channelId,
      workspaceId: selection.workspaceId,
      workspaceName: provider.getWorkspaceName() ?? undefined,
      channelName: channelName ?? undefined,
      isDm,
      dmOwnerEmail: isDm ? senderEmail : undefined,
      agentId: selection.agentId,
    });

    // Confirm the selection in the thread
    const message: IncomingChatMessage = {
      messageId: `${provider.providerId}-selection-${Date.now()}`,
      channelId: selection.channelId,
      workspaceId: selection.workspaceId,
      threadId: selection.threadTs,
      senderId: selection.userId,
      senderName: selection.userName,
      text: "",
      rawText: "",
      timestamp: new Date(),
      isThreadReply: false,
    };

    await provider.sendReply({
      originalMessage: message,
      text: `Agent *${agent.name}* is now assigned to this ${isDm ? "conversation" : "channel"}.\nSend a message to start interacting!`,
    });
  }

  /**
   * Process an incoming chatops message:
   * 1. Check deduplication
   * 2. Look up channel binding and validate prompt
   * 3. Resolve inline agent mention (e.g., ">AgentName message")
   * 4. Fetch thread history for context
   * 5. Execute agent and send reply
   */
  async processMessage(params: {
    message: IncomingChatMessage;
    provider: ChatOpsProvider;
    sendReply?: boolean;
  }): Promise<ChatOpsProcessingResult> {
    const { message, provider, sendReply = true } = params;

    // Deduplication check
    const isNew = await ChatOpsProcessedMessageModel.tryMarkAsProcessed(
      message.messageId,
    );
    if (!isNew) {
      return { success: true };
    }

    // Look up channel binding
    const binding = await ChatOpsChannelBindingModel.findByChannel({
      provider: provider.providerId,
      channelId: message.channelId,
      workspaceId: message.workspaceId,
    });

    if (!binding) {
      return { success: true, error: "NO_BINDING" };
    }

    // Channel binding with no agent yet (e.g. Teams, which calls processMessage
    // directly): auto-assign a clear default or prompt with the picker — never
    // silently drop, which leaves the user with no reply and no explanation.
    if (!binding.agentId) {
      const isDm = message.metadata?.conversationType === "personal";
      const agentId = await this.resolveOrPromptChannelAgent({
        provider,
        message,
        binding,
        isDm,
      });
      if (!agentId) {
        // picker card was sent (or no agents to offer)
        return { success: true };
      }
      binding.agentId = agentId;
    }

    // Verify the agent exists and is an internal agent
    const agent = await AgentModel.findById(binding.agentId);
    if (!agent || agent.agentType !== "agent") {
      logger.warn(
        { agentId: binding.agentId, bindingId: binding.id },
        "[ChatOps] Agent is not an internal agent",
      );
      return {
        success: false,
        error: "AGENT_NOT_FOUND",
      };
    }

    // Check for a thread-level agent override (from a previous swap_agent call).
    // This ensures swaps are scoped to the thread, not the channel binding.
    const effectiveThreadId =
      message.threadId ?? message.channelId ?? message.messageId;
    const threadOverride = await ChatOpsThreadAgentOverrideModel.findByThread(
      binding.id,
      effectiveThreadId,
    );

    let resolvedAgent = agent;
    if (threadOverride) {
      const overrideAgent = await AgentModel.findById(threadOverride.agentId);
      if (!overrideAgent) {
        logger.warn(
          {
            agentId: threadOverride.agentId,
            bindingId: binding.id,
            threadId: effectiveThreadId,
          },
          "[ChatOps] Thread override agent not found, falling back to channel default",
        );
      } else if (overrideAgent.agentType !== "agent") {
        logger.warn(
          {
            agentId: threadOverride.agentId,
            agentType: overrideAgent.agentType,
          },
          "[ChatOps] Thread override agent has unsupported type, falling back to channel default",
        );
      } else {
        resolvedAgent = overrideAgent;
      }
    }

    // Resolve inline agent mention
    const { agentToUse, cleanedMessageText } =
      await this.resolveInlineAgentMention({
        messageText: message.text,
        defaultAgent: resolvedAgent,
      });

    // Security: Validate user has access to the agent
    logger.debug(
      {
        agentId: agentToUse.id,
        agentName: agentToUse.name,
        organizationId: agent.organizationId,
        senderId: message.senderId,
      },
      "[ChatOps] About to validate user access",
    );

    const authResult = await this.validateUserAccess({
      message,
      provider,
      agentId: agentToUse.id,
      agentName: agentToUse.name,
      organizationId: agent.organizationId,
    });

    if (!authResult.success) {
      return { success: false, error: authResult.error };
    }

    // Thread history: attachments still ride the current turn; the text
    // context now comes from the persisted conversation (rawHistory feeds the
    // delta ingestion in executeAndReply).
    const { historyAttachments, rawHistory } = await this.fetchThreadHistory(
      message,
      provider,
    );

    // Build the full message with context — use cleanedMessageText so
    // the "AgentName >" prefix is stripped from what the LLM sees
    const providerLabel = CHATOPS_PROVIDER_LABELS[provider.providerId];
    const threadIdForPrefix = message.threadId ?? message.messageId;
    let systemPrefix = `(${providerLabel} conversation, thread id: ${threadIdForPrefix})`;
    if (provider.providerId === "slack") {
      const permalink = provider.getMessagePermalink
        ? await provider.getMessagePermalink({
            channelId: message.channelId,
            messageId: threadIdForPrefix,
          })
        : null;
      const contextLines = [
        `Slack conversation context:`,
        `- Channel ID: ${message.channelId}`,
        `- Thread message ts: ${threadIdForPrefix}`,
      ];
      if (message.workspaceId) {
        contextLines.push(`- Workspace ID: ${message.workspaceId}`);
      }
      if (permalink) {
        contextLines.push(`- Thread permalink: ${permalink}`);
      }
      systemPrefix = contextLines.join("\n");
    }

    // Group conversations: the agent receives every message, so frame the
    // situation — it's a bot among several humans, told who is speaking —
    // and give it a way to stay silent. The sentinel reply is swallowed in
    // replyByMessageExecutionResult(). Note: only assert a mention positively;
    // people often address the bot by typing its name without a real @mention,
    // so "not mentioned" must never be presented as "not addressed".
    const conversationType = message.metadata?.conversationType;
    if (conversationType === "groupChat" || conversationType === "channel") {
      const botName =
        typeof message.metadata?.botName === "string"
          ? message.metadata.botName
          : null;
      // People also address the bot by the platform name ("Archestra, create
      // a task"), which matches neither the agent nor the chat display name.
      const platformName =
        (await OrganizationModel.getById(agent.organizationId))?.appName ||
        "Archestra";
      const botMentioned = message.metadata?.botMentioned === true;
      const mentionedOthers = Array.isArray(message.metadata?.mentionedOthers)
        ? (message.metadata.mentionedOthers as string[])
        : [];
      const mentionNote = botMentioned
        ? " It @mentions you directly."
        : mentionedOthers.length > 0
          ? ` It @mentions ${mentionedOthers.join(", ")} — another person, not you — so it is most likely addressed to them.`
          : "";
      // A direct @mention always deserves a reply — agents with narrow system
      // prompts otherwise use the silence option to ignore greetings and
      // small talk, which reads as the bot being broken. Only offer the
      // sentinel when the bot was NOT directly mentioned.
      const silenceOption = botMentioned
        ? [
            `The sender explicitly addressed you, so always answer — even if the message is small talk or outside your specialty.`,
          ]
        : [
            `Stay silent only when the message is clearly not your business: it is addressed to another person, or people are plainly talking to each other about something that doesn't involve you. In that case respond with exactly ${CHATOPS_NO_REPLY_SENTINEL} and nothing else — nothing visible will be posted.`,
            `Never post commentary about whether a message is addressed to you or why you are staying silent — either answer the message itself or respond with the sentinel.`,
          ];
      systemPrefix += [
        `\n\nYou are "${agentToUse.name}"${botName ? ` (appearing in this chat as "${botName}")` : ""} — a bot participating in a group conversation with multiple people. People sometimes also address you as "${platformName}".`,
        `The latest message is from ${message.senderName}.${mentionNote}`,
        `Default to replying — when in doubt, reply. Messages addressing you by any of those names (with or without an @mention) are your business.`,
        ...silenceOption,
      ].join("\n");
    }

    // Prior turns are supplied to the model as structured conversation
    // history (persisted messages + provider delta), not as a flattened
    // prose replay — the prefix only frames the current turn.
    let fullMessage = `${systemPrefix}\n\n${cleanedMessageText}`;

    // Tell the model about files that were attached but not delivered (e.g. too
    // large), so it doesn't deny they exist. History drops get per-turn notes
    // in fetchThreadHistory; this covers the current message.
    fullMessage += buildSkippedAttachmentsNote(
      message.skippedAttachments ?? [],
    );

    // Merge history attachments with current message attachments
    const mergedAttachments = [
      ...(historyAttachments || []),
      ...(message.attachments || []),
    ];

    // Execute the A2A message using the agent
    return this.executeAndReply({
      agent: agentToUse,
      // The persistent thread agent (override ?? binding default) seeds the
      // conversation; an inline "AgentName >" route is one-shot and must not
      // become the web continuation's agent.
      threadAgentId: resolvedAgent.id,
      binding,
      message: {
        ...message,
        attachments:
          mergedAttachments.length > 0 ? mergedAttachments : undefined,
      },
      provider,
      fullMessage,
      cleanedMessageText,
      rawHistory,
      sendReply,
      userId: authResult.userId,
    });
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Send a welcome DM to a newly auto-provisioned user.
   * Non-fatal — failures are logged but do not block message processing.
   */
  private async sendAutoProvisionWelcome(params: {
    provider: ChatOpsProvider;
    message: IncomingChatMessage;
    invitationId: string;
    displayName: string;
  }): Promise<void> {
    const { provider, message, invitationId, displayName } = params;
    try {
      // Skip welcome message when SSO is enabled — users just sign in via their IdP
      if (await isSsoConfigured()) return;

      const welcome = await buildWelcomeMessage({
        invitationId,
        email: message.senderEmail || "",
        name: displayName,
      });

      const isDM = message.metadata?.channelType === "im";

      if (isDM && provider.sendDirectMessage) {
        // In DMs, reply in the user's thread so it appears in Chat tab.
        // Pass channelId to skip conversations.open (which routes to History).
        // Pass threadId to thread the reply to the user's original message.
        await provider.sendDirectMessage({
          userId: message.senderId,
          text: welcome.text,
          actionUrl: welcome.actionUrl,
          actionLabel: welcome.actionLabel,
          channelId: message.channelId,
          threadId: message.threadId,
        });
      } else if (provider.sendDirectMessage) {
        // In channels, send a separate DM to the user
        await provider.sendDirectMessage({
          userId: message.senderId,
          text: welcome.text,
          actionUrl: welcome.actionUrl,
          actionLabel: welcome.actionLabel,
        });
      } else if (isDM) {
        // Fallback in DMs: send the link inline (it's private)
        await provider.sendReply({
          originalMessage: message,
          text: `${welcome.text}\n\n[${welcome.actionLabel}](${welcome.actionUrl})`,
        });
      } else {
        // Fallback in channels: don't expose the signup link.
        // MS Teams requires each user to install the app personally before DMs work.
        await provider.sendReply({
          originalMessage: message,
          text: [
            welcome.text,
            "",
            "💡 To send me a direct message in Teams, you first need to install the Archestra app personally — click **Add** when Teams prompts you.",
            "",
            "Once installed, send me a direct message and I'll send you back a signup link.",
          ].join("\n"),
        });
      }
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[ChatOps] Failed to send auto-provision welcome message",
      );
    }
  }

  /**
   * Pick a default agent for a channel that has none yet so onboarding "just
   * works": the org-wide default agent if set, else the sole agent available to
   * the sender — INCLUDING their personal "My Assistant" — so a fresh per-user
   * setup just works. Returns whether the agent should be pinned as the shared
   * channel default (true for the org default / a shared agent; false for a
   * personal agent, which is per-user). Returns null when the choice is
   * ambiguous (0 or 2+ candidates) so the caller prompts with the picker card.
   */
  private async autoResolveChannelAgentId(params: {
    organizationId: string;
    senderEmail?: string;
  }): Promise<{ agentId: string; persist: boolean } | null> {
    // 1. Org-wide default — an explicit, shared choice; pin it to the channel.
    const org = await OrganizationModel.getById(params.organizationId);
    if (org?.defaultAgentId) {
      const agent = await AgentModel.findById(org.defaultAgentId);
      if (agent?.agentType === "agent") {
        return { agentId: org.defaultAgentId, persist: true };
      }
    }
    // 2. The sole agent available to this sender (incl. their personal agent).
    //    A personal agent is per-user, so use it for this reply but DON'T pin
    //    it as the shared default (other members would be denied access to it).
    const accessible = await this.getAccessibleChatopsAgents({
      senderEmail: params.senderEmail,
      isDm: true,
    });
    if (accessible.length === 1) {
      const agent = await AgentModel.findById(accessible[0].id);
      return {
        agentId: accessible[0].id,
        persist: agent?.scope !== "personal",
      };
    }
    return null;
  }

  /**
   * Resolve a channel's default agent (pinning shared ones), or prompt with the
   * picker card. Returns the agent id to use for this message, or null when the
   * picker was sent (the caller should stop processing this message).
   */
  private async resolveOrPromptChannelAgent(params: {
    provider: ChatOpsProvider;
    message: IncomingChatMessage;
    binding: { id: string; organizationId: string };
    isDm: boolean;
  }): Promise<string | null> {
    const { provider, message, binding, isDm } = params;
    const resolved = await this.autoResolveChannelAgentId({
      organizationId: binding.organizationId,
      senderEmail: message.senderEmail,
    });
    if (resolved) {
      if (resolved.persist) {
        await ChatOpsChannelBindingModel.update(binding.id, {
          agentId: resolved.agentId,
        });
      }
      logger.info(
        {
          bindingId: binding.id,
          agentId: resolved.agentId,
          pinned: resolved.persist,
        },
        "[ChatOps] Resolved a default agent for an unassigned channel",
      );
      return resolved.agentId;
    }
    await this.sendAgentSelectionCard({
      provider,
      message,
      isWelcome: true,
      isDm,
    });
    return null;
  }

  private async sendAgentSelectionCard({
    provider,
    message,
    isWelcome,
    isDm,
  }: {
    provider: ChatOpsProvider;
    message: IncomingChatMessage;
    isWelcome: boolean;
    isDm: boolean;
  }): Promise<void> {
    const agents = await this.getAccessibleChatopsAgents({
      senderEmail: message.senderEmail,
      isDm,
    });

    if (agents.length === 0) {
      await provider.sendReply({
        originalMessage: message,
        text: `No agents are available for you in ${provider.displayName}.\nContact your administrator to get access to an agent with ${provider.displayName} enabled.`,
      });
      return;
    }

    await provider.sendAgentSelectionCard({
      message,
      agents,
      isWelcome,
    });
  }

  private startProcessedMessageCleanup(): void {
    if (this.cleanupInterval) return;

    this.runCleanup();
    this.cleanupInterval = setInterval(
      () => this.runCleanup(),
      CHATOPS_MESSAGE_RETENTION.CLEANUP_INTERVAL_MS,
    );
  }

  private async runCleanup(): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(
      cutoffDate.getDate() - CHATOPS_MESSAGE_RETENTION.RETENTION_DAYS,
    );

    try {
      await ChatOpsProcessedMessageModel.cleanupOldRecords(cutoffDate);
    } catch (error) {
      logger.error(
        { error: errorMessage(error) },
        "[ChatOps] Failed to cleanup old processed messages",
      );
    }
  }

  /**
   * Resolve inline agent mention from message text.
   * Pattern: "AgentName > message" switches to a different agent.
   * Tolerant matching handles variations like "Agent Peter > hello", "kid>how are you".
   */
  private async resolveInlineAgentMention(params: {
    messageText: string;
    defaultAgent: { id: string; name: string };
  }): Promise<{
    agentToUse: { id: string; name: string };
    cleanedMessageText: string;
  }> {
    const { messageText, defaultAgent } = params;

    // Look for ">" delimiter - pattern is "AgentName > message"
    const delimiterIndex = messageText.indexOf(">");
    if (delimiterIndex === -1) {
      return { agentToUse: defaultAgent, cleanedMessageText: messageText };
    }

    const potentialAgentName = messageText.slice(0, delimiterIndex).trim();
    const messageAfterDelimiter = messageText.slice(delimiterIndex + 1).trim();

    // If nothing before the delimiter, not a valid agent switch
    if (!potentialAgentName) {
      return { agentToUse: defaultAgent, cleanedMessageText: messageText };
    }

    const availableAgents = await AgentModel.findAllInternalAgents();

    // Try to find a matching agent using tolerant matching
    for (const agent of availableAgents) {
      if (matchesAgentName(potentialAgentName, agent.name)) {
        return {
          agentToUse: agent,
          cleanedMessageText: messageAfterDelimiter,
        };
      }
    }

    // The text contained ">" but the prefix is not a known agent name, so this
    // was never an agent switch — it's ordinary message text that happens to
    // contain ">". Return the full original message so nothing before the ">"
    // is dropped (e.g. "compare A > B" must reach the agent intact).
    return {
      agentToUse: defaultAgent,
      cleanedMessageText: messageText,
    };
  }

  private async fetchThreadHistory(
    message: IncomingChatMessage,
    provider: ChatOpsProvider,
  ): Promise<{
    historyAttachments: A2AAttachment[];
    /**
     * Provider entries with ingestion-ready text: file-only turns rendered
     * as attachment lines and skipped-attachment notes appended to the turn
     * they belong to. Only non-bot entries are ingested — the agent's own
     * turns are persisted directly from execution results.
     */
    rawHistory: ChatThreadMessage[];
  }> {
    logger.debug(
      {
        messageId: message.messageId,
        threadId: message.threadId,
        channelId: message.channelId,
        workspaceId: message.workspaceId,
        isThreadReply: message.isThreadReply,
      },
      "[ChatOps] fetchThreadHistory called",
    );

    if (!message.threadId || !message.isThreadReply) {
      logger.debug(
        "[ChatOps] No prior thread context, skipping thread history fetch",
      );
      return { historyAttachments: [], rawHistory: [] };
    }

    try {
      const history = await provider.getThreadHistory({
        channelId: message.channelId,
        workspaceId: message.workspaceId,
        threadId: message.threadId,
        excludeMessageId: message.messageId,
      });

      logger.debug(
        { historyCount: history.length },
        "[ChatOps] Thread history fetched",
      );

      const renderedTexts = history.map((msg) => {
        const text = msg.isFromBot ? stripBotFooter(msg.text) : msg.text;
        // A file-only turn has no text; name its attachments so the turn is
        // meaningful (the file arrives separately or gets a skip note below).
        if (!text.trim() && msg.files?.length) {
          const names = msg.files
            .map((f) => (f.name ? `"${f.name}"` : "an unnamed file"))
            .join(", ");
          return `[sent ${msg.files.length === 1 ? "an attachment" : "attachments"}: ${names}]`;
        }
        return text;
      });

      // Collect files from non-bot user messages, remembering the turn each
      // file came from so drops can be surfaced on that turn.
      const fileRefs = history.flatMap((msg, turnIndex) =>
        !msg.isFromBot && msg.files
          ? msg.files.map((file) => ({ file, turnIndex }))
          : [],
      );

      const historyAttachments: A2AAttachment[] = [];
      const skippedByTurn = new Map<number, SkippedAttachment[]>();
      const addSkip = (turnIndex: number, skipped: SkippedAttachment): void => {
        const existing = skippedByTurn.get(turnIndex);
        if (existing) {
          existing.push(skipped);
        } else {
          skippedByTurn.set(turnIndex, [skipped]);
        }
      };

      if (fileRefs.length > 0) {
        // Calculate how much budget the current message attachments already use
        const currentAttachmentSize =
          message.attachments?.reduce(
            (sum, a) => sum + Math.ceil((a.contentBase64.length * 3) / 4),
            0,
          ) ?? 0;
        const remainingBudget =
          CHATOPS_ATTACHMENT_LIMITS.MAX_TOTAL_ATTACHMENTS_SIZE -
          currentAttachmentSize;

        if (remainingBudget <= 0) {
          for (const { file, turnIndex } of fileRefs) {
            addSkip(turnIndex, {
              name: file.name,
              sizeBytes: file.size,
              reason: "total_limit_reached",
            });
          }
        } else {
          try {
            const outcomes = await provider.downloadFiles(
              fileRefs.map((ref) => ref.file),
            );
            // Trim delivered files to the remaining budget; once it overflows,
            // every later delivery is surfaced as skipped (mirrors the
            // provider-side budget semantics).
            let totalSize = 0;
            let budgetExhausted = false;
            outcomes.forEach((outcome, index) => {
              const ref = fileRefs[index];
              if (!ref) return;
              if (outcome.status === "skipped") {
                addSkip(ref.turnIndex, outcome.skipped);
                return;
              }
              const size = Math.ceil(
                (outcome.attachment.contentBase64.length * 3) / 4,
              );
              if (budgetExhausted || totalSize + size > remainingBudget) {
                budgetExhausted = true;
                addSkip(ref.turnIndex, {
                  name: ref.file.name,
                  sizeBytes: size,
                  reason: "total_limit_reached",
                });
                return;
              }
              totalSize += size;
              historyAttachments.push(outcome.attachment);
            });
            if (historyAttachments.length > 0) {
              logger.info(
                {
                  downloadedCount: historyAttachments.length,
                  totalHistoryFiles: fileRefs.length,
                },
                "[ChatOps] Downloaded attachments from thread history",
              );
            }
          } catch (error) {
            logger.warn(
              { error: errorMessage(error) },
              "[ChatOps] Failed to download history attachments",
            );
          }
        }
      }

      // Surface drops on the turn they belong to, so "use the screenshot
      // above" gets an explanation instead of a denial.
      for (const [turnIndex, skips] of skippedByTurn) {
        const line = renderedTexts[turnIndex];
        if (line !== undefined) {
          renderedTexts[turnIndex] =
            line + buildHistorySkippedAttachmentsNote(skips);
        }
      }

      const rawHistory = history.map((msg, index) => ({
        ...msg,
        text: renderedTexts[index] ?? msg.text,
      }));
      return { historyAttachments, rawHistory };
    } catch (error) {
      logger.error(
        { error: errorMessage(error) },
        "[ChatOps] Failed to fetch thread history",
      );
      return { historyAttachments: [], rawHistory: [] };
    }
  }

  /**
   * Validate that user has access to the agent.
   * 1. Use pre-resolved email from TeamsInfo (Bot Framework), or fall back to Graph API
   * 2. Look up Archestra user by email
   * 3. Check user has team-based access to the agent
   */
  private async validateUserAccess(params: {
    message: IncomingChatMessage;
    provider: ChatOpsProvider;
    agentId: string;
    agentName: string;
    organizationId: string;
  }): Promise<
    { success: true; userId: string } | { success: false; error: string }
  > {
    const { message, provider, agentId, agentName, organizationId } = params;

    // Try pre-resolved email first (from Bot Framework TeamsInfo, no Graph API needed)
    let userEmail = message.senderEmail || null;
    if (!userEmail) {
      // Fall back to Graph API (requires User.Read.All permission)
      logger.debug(
        { senderId: message.senderId },
        "[ChatOps] No pre-resolved email, falling back to Graph API",
      );
      userEmail = await provider.getUserEmail(message.senderId);
    }
    logger.debug(
      { senderId: message.senderId, userEmail },
      "[ChatOps] User email resolved",
    );

    if (!userEmail) {
      logger.warn(
        { senderId: message.senderId },
        "[ChatOps] Could not resolve user email via TeamsInfo or Graph API",
      );
      await this.sendSecurityErrorReply(
        provider,
        message,
        "Could not verify your identity. Please ensure the bot is properly installed in your team or chat.",
      );
      return {
        success: false,
        error: "Could not resolve user email for security validation",
      };
    }

    // Look up Archestra user by email — auto-provision if not found
    let displayName = "";
    const provisioned = await ensureProvisionedUser({
      email: userEmail,
      resolveDisplayName: async () => {
        displayName =
          (await provider.getUserName?.(message.senderId)) ||
          message.senderName;
        return displayName;
      },
      provider: provider.providerId,
    });
    if (!provisioned) {
      logger.error(
        { senderEmail: userEmail },
        "[ChatOps] Auto-provisioned user not found after creation",
      );
      return {
        success: false,
        error: "Failed to auto-provision user",
      };
    }
    const user = provisioned.user;
    if (provisioned.invitationId !== null) {
      // Send welcome message (non-blocking)
      this.sendAutoProvisionWelcome({
        provider,
        message,
        invitationId: provisioned.invitationId,
        displayName,
      }).catch(() => {});
    }

    // Check if user has access to this specific agent (via team membership or admin)
    const isAgentAdmin = await userHasPermission(
      user.id,
      organizationId,
      "agent",
      "admin",
    );
    const hasAccess = await AgentTeamModel.userHasAgentAccess(
      user.id,
      agentId,
      isAgentAdmin,
    );

    if (!hasAccess) {
      logger.warn(
        {
          userId: user.id,
          userEmail,
          agentId,
          agentName,
        },
        "[ChatOps] User does not have access to agent",
      );
      await this.sendSecurityErrorReply(
        provider,
        message,
        `You don't have access to the agent "${agentName}". Contact your administrator for access.`,
      );
      return {
        success: false,
        error: "Unauthorized: user does not have access to this agent",
      };
    }

    logger.info(
      {
        userId: user.id,
        userEmail,
        agentId,
        agentName,
      },
      "[ChatOps] User authorized to invoke agent",
    );

    return { success: true, userId: user.id };
  }

  /**
   * Send a security error reply back to the user via the chat provider.
   */
  private async sendSecurityErrorReply(
    provider: ChatOpsProvider,
    message: IncomingChatMessage,
    errorText: string,
  ): Promise<void> {
    logger.debug(
      {
        messageId: message.messageId,
        hasConversationRef: Boolean(message.metadata?.conversationReference),
      },
      "[ChatOps] Sending security error reply",
    );
    try {
      await provider.sendReply({
        originalMessage: message,
        text: `⚠️ **Access Denied**\n\n${errorText}`,
      });
      logger.debug("[ChatOps] Security error reply sent successfully");
    } catch (error) {
      logger.error(
        { error: errorMessage(error) },
        "[ChatOps] Failed to send security error reply",
      );
    }
  }

  /**
   * Seed chatops config from environment variables into the database.
   * Only runs on first startup — if DB already has config, this is a no-op.
   */
  private async seedConfigFromEnvVars(): Promise<void> {
    await this.seedMsTeamsConfigFromEnvVars();
    await this.seedSlackConfigFromEnvVars();
    await this.seedTelegramConfigFromEnvVars();
  }

  private async seedMsTeamsConfigFromEnvVars(): Promise<void> {
    try {
      const existing = await ChatOpsConfigModel.getMsTeamsConfig();
      if (existing) return;

      const appId = process.env.ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID || "";
      const appSecret = process.env.ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET || "";
      if (!appId || !appSecret) return;

      const tenantId = process.env.ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID || "";
      await ChatOpsConfigModel.saveMsTeamsConfig({
        enabled: process.env.ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED === "true",
        appId,
        appSecret,
        tenantId,
        graphTenantId:
          process.env.ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_TENANT_ID || tenantId,
        graphClientId:
          process.env.ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_ID || appId,
        graphClientSecret:
          process.env.ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_SECRET ||
          appSecret,
      });
      logger.info("[ChatOps] Seeded MS Teams config from env vars to DB");
    } catch (error) {
      logger.error(
        { error: errorMessage(error) },
        "[ChatOps] Failed to seed MS Teams config from env vars",
      );
    }
  }

  private async seedSlackConfigFromEnvVars(): Promise<void> {
    try {
      const existing = await ChatOpsConfigModel.getSlackConfig();
      if (existing) return;

      const botToken = process.env.ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN || "";
      const signingSecret =
        process.env.ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET || "";
      const connectionMode =
        (process.env
          .ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE as ChatOpsConnectionMode) ||
        SLACK_DEFAULT_CONNECTION_MODE;
      const appLevelToken =
        process.env.ARCHESTRA_CHATOPS_SLACK_APP_LEVEL_TOKEN || "";

      // Webhook mode requires botToken + signingSecret
      // Socket mode requires botToken + appLevelToken
      const hasWebhookCreds = botToken && signingSecret;
      const hasSocketCreds = botToken && appLevelToken;
      if (!hasWebhookCreds && !hasSocketCreds) return;

      await ChatOpsConfigModel.saveSlackConfig({
        enabled: process.env.ARCHESTRA_CHATOPS_SLACK_ENABLED === "true",
        botToken,
        signingSecret,
        appId: process.env.ARCHESTRA_CHATOPS_SLACK_APP_ID || "",
        connectionMode,
        appLevelToken,
      });
      logger.info("[ChatOps] Seeded Slack config from env vars to DB");
    } catch (error) {
      logger.error(
        { error: errorMessage(error) },
        "[ChatOps] Failed to seed Slack config from env vars",
      );
    }
  }

  private async seedTelegramConfigFromEnvVars(): Promise<void> {
    try {
      // Don't store tokens for a feature-flagged-off integration
      if (!config.chatops.telegramEnabled) return;

      const existing = await ChatOpsConfigModel.getTelegramConfig();
      if (existing) return;

      const botToken = process.env.ARCHESTRA_CHATOPS_TELEGRAM_BOT_TOKEN || "";
      if (!botToken) return;

      await ChatOpsConfigModel.saveTelegramConfig({
        enabled: true,
        botToken,
      });
      logger.info("[ChatOps] Seeded Telegram config from env vars to DB");
    } catch (error) {
      logger.error(
        { error: errorMessage(error) },
        "[ChatOps] Failed to seed Telegram config from env vars",
      );
    }
  }

  private async executeAndReply(params: {
    agent: { id: string; name: string };
    /** The thread's persistent agent (override ?? binding default). */
    threadAgentId: string;
    binding: {
      id: string;
      organizationId: string;
      agentId: string | null;
      isDm?: boolean | null;
    };
    message: IncomingChatMessage;
    provider: ChatOpsProvider;
    fullMessage: string;
    /** The user's text without the system prefix — what gets persisted. */
    cleanedMessageText: string;
    /** Raw provider thread entries, for conversation delta ingestion. */
    rawHistory: ChatThreadMessage[];
    sendReply: boolean;
    userId: string;
  }): Promise<ChatOpsProcessingResult> {
    const {
      agent,
      threadAgentId,
      binding,
      message,
      provider,
      fullMessage,
      cleanedMessageText,
      rawHistory,
      sendReply,
      userId,
    } = params;

    // Stamp the start time so a deliberate no-reply can report how long the
    // agent thought before deciding (shown in the Teams channel placeholder).
    message.metadata = {
      ...message.metadata,
      processingStartedAt: Date.now(),
    };

    // Send typing indicator before execution starts (non-fatal).
    // Slack always has threadId (falls back to event.ts); Teams may not
    // (only set for thread replies) but doesn't need it (uses conversationReference).
    if (sendReply && provider.setTypingStatus) {
      await provider
        .setTypingStatus(
          message.channelId,
          message.threadId ?? "",
          message.metadata,
        )
        .catch(() => {});
    }

    let conversationIdForError: string | undefined;
    // Once the assistant turn is handled, a later failure is delivery-only
    // (e.g. the provider reply call) — the web transcript already shows the
    // successful answer, so no error card is recorded for it.
    let assistantTurnHandled = false;
    try {
      // The thread's persisted conversation is the canonical history for this
      // turn and the lock scope for concurrency with web runs.
      const effectiveThreadId =
        message.threadId ?? message.channelId ?? message.messageId;
      const turn = await resolveOrCreateThreadConversation({
        bindingId: binding.id,
        organizationId: binding.organizationId,
        effectiveThreadId,
        provider: provider.providerId,
        senderUserId: userId,
        agentId: threadAgentId,
        seedTitle: cleanedMessageText,
      });
      const conversationId = turn.conversation.id;
      conversationIdForError = conversationId;

      const runLock = await ActiveChatRunModel.create({
        conversationId,
        userId,
        organizationId: binding.organizationId,
      });
      if (!runLock) {
        if (sendReply) {
          await provider.sendReply({
            originalMessage: message,
            text: "The agent is already responding to this conversation — try again once it finishes.",
            footer: buildAgentFooter(agent.name),
            conversationReference: message.metadata?.conversationReference,
          });
        }
        return { success: false, error: "conversation run already active" };
      }

      // Known limitations (deliberate): acquisition goes through the model,
      // not ActiveChatRunService, so a crashed ChatOps run is reclaimed by the
      // stale-run reaper rather than inline recovery; and the web Stop button
      // is not observed mid-run.
      let runStatus: "completed" | "failed" = "failed";
      // Heartbeat so the stale-run reaper doesn't reclaim a long tool-looping
      // turn mid-execution (ChatOps has no event stream touching the row).
      const heartbeat = setInterval(() => {
        void ActiveChatRunModel.touch(runLock.id).catch(() => {});
      }, CHATOPS_RUN_HEARTBEAT_MS);
      try {
        // Ingest provider-side turns this conversation hasn't seen (chatter
        // between invocations; a pre-persistence thread's prior human turns)
        // under the lock, so cursor advancement can't race a concurrent turn.
        const loadRows = async (): Promise<ChatMessage[]> =>
          (await MessageModel.findByConversation(conversationId)).map(
            (row) => row.content as ChatMessage,
          );
        let contents = await loadRows();
        const deltaEntries = rawHistory
          .filter((m) => !m.isFromBot && m.messageId !== message.messageId)
          .map((m) => ({
            providerMessageId: m.messageId,
            providerTs: m.messageId,
            text: m.text,
            authorName: m.senderName,
            sentAt: m.timestamp,
          }));
        if (deltaEntries.length > 0) {
          await ingestProviderDelta({
            mapping: turn.mapping,
            provider: provider.providerId,
            entries: deltaEntries,
            existingProviderMessageIds: collectProviderMessageIds(contents),
          });
          contents = await loadRows();
        }
        const conversationHistory = filterHistoryForChatOpsContext({
          messages: contents,
          provider: provider.providerId,
          senderIsOwner: turn.senderIsOwner,
          isDm: binding.isDm === true,
        });
        // Tag the produced assistant turn by what this run actually saw, not
        // by who invoked it: an owner turn over a thread with no web-side
        // rows is provider-scoped, so teammates in the channel keep seeing
        // the bot's own publicly posted answers in their context.
        const providerScopedCount = filterHistoryForChatOpsContext({
          messages: contents,
          provider: provider.providerId,
          senderIsOwner: false,
          isDm: false,
        }).length;
        const contextScope: "provider" | "full" =
          conversationHistory.length > providerScopedCount
            ? "full"
            : "provider";

        // Persist the invoking turn before execution, with the same message
        // id the A2A layer will use — transcript and generation share one
        // turn. The persisted copy is the clean user text; the per-turn
        // system prefix is regenerated each turn and never enters history.
        const requestMessageId = crypto.randomUUID();
        await persistChatOpsUserTurn({
          conversationId,
          messageId: requestMessageId,
          text: cleanedMessageText,
          provider: provider.providerId,
          providerMessageId: message.messageId,
          authorName: message.senderName,
          authorUserId: userId,
        });

        const executeParams = {
          agent,
          binding,
          message,
          provider,
          fullMessage,
          userId,
          conversationTurn: {
            conversationId,
            conversationHistory,
            requestMessageId,
          },
        };
        let execution: Awaited<ReturnType<ChatOpsManager["executeMessage"]>>;
        try {
          execution = await this.executeMessage(executeParams);
        } catch (error) {
          // Web chat surfaces transient provider failures as a retry button;
          // chatops has no interactive affordance, so one automatic retry
          // stands in for it. The retry re-runs the whole agent turn, exactly
          // like a user-clicked retry would.
          if (!isTransientProviderError(error)) {
            throw error;
          }
          logger.info(
            {
              messageId: message.messageId,
              agentId: agent.id,
              errorCode: error.chatErrorResponse.code,
            },
            "[ChatOps] Retrying execution once after a transient provider error",
          );
          execution = await this.executeMessage(executeParams);
        }
        const { result, responseAgent } = execution;

        // Persist the full assistant turn (tool parts included), tagged with
        // the history scope that produced it (the channel-leak guard input).
        // A deliberately silent turn (NO_REPLY sentinel) posts nothing and is
        // not persisted — its narration must not pollute the web transcript.
        const responseText = (result.responseUiMessage?.parts ?? [])
          .filter(
            (part): part is { type: "text"; text: string } =>
              part.type === "text",
          )
          .map((part) => part.text)
          .join("\n");
        if (
          result.responseUiMessage &&
          !responseText.includes(CHATOPS_NO_REPLY_SENTINEL)
        ) {
          await persistChatOpsAssistantTurn({
            conversationId,
            assistantMessage: result.responseUiMessage,
            provider: provider.providerId,
            contextScope,
          });
        }
        assistantTurnHandled = true;

        runStatus = "completed";
        return await this.replyByMessageExecutionResult({
          agent: responseAgent,
          message,
          provider,
          sendReply,
          result: result.response,
          conversationId,
        });
      } finally {
        clearInterval(heartbeat);
        await ActiveChatRunModel.markTerminal({
          runId: runLock.id,
          status: runStatus,
        });
      }
    } catch (error) {
      logger.error(
        { messageId: message.messageId, error: errorMessage(error) },
        "[ChatOps] Failed to execute A2A message",
      );

      // Surface the failure on the conversation so the web view renders the
      // same inline error card interactive chat shows.
      if (conversationIdForError && !assistantTurnHandled) {
        const chatError: ChatErrorResponse = (
          error as { chatErrorResponse?: ChatErrorResponse }
        ).chatErrorResponse ?? {
          code: ChatErrorCode.Unknown,
          message: errorMessage(error),
          isRetryable: false,
        };
        await recordChatOpsConversationError({
          conversationId: conversationIdForError,
          error: chatError,
        });
      }

      if (sendReply) {
        await this.sendExecutionErrorReply({
          provider,
          message,
          error,
          agentName: agent.name,
          llmContext: {
            organizationId: binding.organizationId,
            userId,
            agentId: agent.id,
          },
        });
      }

      return { success: false, error: errorMessage(error) };
    }
  }

  /**
   * Reply to a failed execution. Known error shapes get actionable replies;
   * anything else falls back to the generic apology with the raw error as a
   * subtle footer.
   */
  private async sendExecutionErrorReply(params: {
    provider: ChatOpsProvider;
    message: IncomingChatMessage;
    error: unknown;
    /** The responding agent's name, so error replies carry the same footer. */
    agentName?: string;
    /** When present, used to name the API key/model the failed run resolved to. */
    llmContext?: { organizationId: string; userId: string; agentId: string };
  }): Promise<void> {
    const { provider, message, error, agentName, llmContext } = params;

    // Every reply — success or failure — leads with the agent footer; error
    // details, when present, trail after the agent name.
    const footer = (extra?: string): string | undefined =>
      agentName ? buildAgentFooter(agentName, extra) : extra;

    // A per-user provider the user hasn't linked yet → a friendly prompt
    // with a link to connect (chatops can't render the interactive flow).
    if (error instanceof LlmProviderAuthRequiredError) {
      await provider.sendReply({
        originalMessage: message,
        text: `This agent uses ${error.providerLabel}, which is per-user. Connect your own ${error.providerLabel} account, then try again: ${config.frontendBaseUrl}/settings`,
        footer: footer(),
        conversationReference: message.metadata?.conversationReference,
      });
      return;
    }

    const errMsg = errorMessage(error);
    // Show truncated error details as a subtle footer (max 500 chars)
    const errorDetail =
      errMsg.length > 500 ? `${errMsg.slice(0, 500)}…` : errMsg;

    // The LLM provider rejected the API key (e.g. Anthropic's "invalid
    // x-api-key"). Users rarely realize the bot resolves its model/key the
    // same way in-app chat does, so name the key that was used and where to
    // fix it instead of leaving only the provider's cryptic one-liner.
    if (isLlmProviderAuthError(errMsg)) {
      const usedLlm = llmContext
        ? await this.describeLlmUsedForRun(llmContext)
        : null;
      await provider.sendReply({
        originalMessage: message,
        text: [
          "Sorry, I couldn't process your request — the LLM provider rejected the API key.",
          "",
          usedLlm ??
            "Check the API key configured for this agent (or your organization's LLM settings).",
          "",
          `Update the key or configure a different one, then try again: ${config.frontendBaseUrl}/llm/model-providers`,
        ].join("\n"),
        footer: footer(errorDetail),
        conversationReference: message.metadata?.conversationReference,
      });
      return;
    }

    await provider.sendReply({
      originalMessage: message,
      text: "Sorry, I encountered an error processing your request.",
      footer: footer(errorDetail),
      conversationReference: message.metadata?.conversationReference,
    });
  }

  /**
   * Best-effort description of the model/API key a chatops run resolved to,
   * re-running the same deterministic resolution the execution used (agent's
   * configured model/key → org default → best-available; the acting user's
   * /chat default is deliberately excluded, matching the A2A executor). Returns
   * null when anything fails — this runs on an error path and must never throw.
   */
  private async describeLlmUsedForRun(params: {
    organizationId: string;
    userId: string;
    agentId: string;
  }): Promise<string | null> {
    try {
      const agent = await AgentModel.findById(params.agentId);
      if (!agent) return null;

      const { selectedModel, selectedProvider } =
        await resolveConversationLlmSelectionForAgent({
          agent: { llmApiKeyId: agent.llmApiKeyId, modelId: agent.modelId },
          organizationId: params.organizationId,
          userId: params.userId,
          includeMemberChatDefault: false,
        });

      const userTeamIds = await TeamModel.getUserTeamIds(params.userId);
      const key = await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: params.organizationId,
        userId: params.userId,
        userTeamIds,
        provider: selectedProvider,
        conversationId: null,
        agentLlmApiKeyId: agent.llmApiKeyId,
      });

      const providerLabel =
        providerDisplayNames[selectedProvider] ?? selectedProvider;
      const keyDescription = key
        ? `the ${LLM_KEY_SCOPE_LABELS[key.scope]} ${providerLabel} API key "${key.name}"`
        : `the ${providerLabel} API key from the server environment`;
      return `This request used ${keyDescription} with model \`${selectedModel}\`.`;
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[ChatOps] Failed to describe the LLM selection for an error reply",
      );
      return null;
    }
  }

  /**
   * When swap_agent hands a thread to a different agent, the mapped
   * conversation follows — web continuation must run the swapped agent, not
   * the stale pre-swap one. Inline `AgentName >` routing is deliberately
   * one-shot and never lands here. Model/key re-resolve from the swapped
   * agent's own configuration, mirroring conversation creation.
   */
  private async syncConversationAgent(params: {
    conversationId: string | undefined;
    organizationId: string;
    swappedAgent: {
      id: string;
      llmApiKeyId?: string | null;
      modelId?: string | null;
    };
    userId: string;
  }): Promise<void> {
    const { conversationId, organizationId, swappedAgent, userId } = params;
    if (!conversationId) {
      return;
    }
    const conversation = await ConversationModel.findByIdInOrganization({
      id: conversationId,
      organizationId,
    });
    if (!conversation || conversation.agentId === swappedAgent.id) {
      return;
    }
    const llmSelection = await resolveConversationLlmSelectionForAgent({
      agent: {
        llmApiKeyId: swappedAgent.llmApiKeyId ?? null,
        modelId: swappedAgent.modelId ?? null,
      },
      organizationId,
      userId,
      includeMemberChatDefault: false,
    });
    await ConversationModel.update(
      conversation.id,
      conversation.userId,
      organizationId,
      {
        agentId: swappedAgent.id,
        modelId: llmSelection.modelId,
        chatApiKeyId: llmSelection.chatApiKeyId,
      },
    );
  }

  private async replyByMessageExecutionResult(params: {
    agent: { id: string; name: string };
    message: IncomingChatMessage;
    provider: ChatOpsProvider;
    sendReply: boolean;
    currentApprovalId?: string; // if replying from an approval flow
    result: A2AProtocolSendMessageResponse;
    /** When set, the reply footer links to the web copy of the conversation. */
    conversationId?: string;
  }): Promise<ChatOpsProcessingResult> {
    const {
      agent,
      message,
      provider,
      sendReply,
      currentApprovalId,
      result,
      conversationId,
    } = params;

    const approvalRequests =
      extractApprovalRequestsFromSendMessageResult(result);
    if (approvalRequests.length > 0) {
      return await this.replyWithApprovalForm({
        agent,
        message,
        provider,
        sendReply,
        approvalRequests,
        currentApprovalId,
        result,
      });
    }

    const resultMessage = extractMessageFromSendMessageResult(result);
    const text = (resultMessage.parts || [])
      .map((part) => part.text)
      .join("\n");
    let agentResponse = stripThinkingBlocks(text);

    // The agent's way to stay silent in group conversations — post nothing.
    // The sentinel ANYWHERE in the response means silence: models often
    // narrate the decision ("this is addressed to Matvey... [NO_REPLY]"),
    // and that narration must never be posted. A genuine answer has no
    // reason to contain the sentinel.
    let agentChoseSilence = false;
    if (agentResponse.includes(CHATOPS_NO_REPLY_SENTINEL)) {
      logger.info(
        { messageId: message.messageId, agentId: agent.id },
        "[ChatOps] Agent chose not to reply",
      );
      agentChoseSilence = true;
      agentResponse = "";
    }

    if (sendReply && agentResponse) {
      await provider.sendReply({
        originalMessage: message,
        text: agentResponse,
        footer: buildAgentFooter(
          agent.name,
          conversationId
            ? `continue on the web: ${config.frontendBaseUrl}/chat/${conversationId}`
            : undefined,
        ),
        // Teach the off switch once per channel thread: sticky auto-reply only
        // applies in channels, so the hint rides the bot's first reply there.
        ...((await this.shouldHintThreadMute(provider, message)) && {
          hint: THREAD_MUTE_HINT,
        }),
        conversationReference: message.metadata?.conversationReference,
      });
    } else if (
      sendReply &&
      !agentResponse &&
      message.metadata?.placeholderActivityId
    ) {
      // A placeholder "Thinking..." message was posted (Teams channels) —
      // update it so it doesn't linger. Deliberate silence gets a subtle
      // note; an unexpectedly empty result keeps the "(No response)" marker.
      const startedAt = message.metadata?.processingStartedAt;
      const seconds =
        typeof startedAt === "number"
          ? Math.max(1, Math.round((Date.now() - startedAt) / 1000))
          : null;
      await provider.sendReply({
        originalMessage: message,
        text: agentChoseSilence
          ? seconds
            ? `_Thought for ${seconds}s — no reply needed_`
            : "_No reply needed_"
          : "_(No response)_",
        conversationReference: message.metadata?.conversationReference,
      });
    } else if (sendReply && !agentResponse) {
      // Nothing was (or will be) posted to the thread — clear the transient
      // "thinking" indicator so it doesn't spin forever (Slack only
      // auto-clears it when a message is posted).
      await provider
        .clearTypingStatus?.(message.channelId, message.threadId ?? "")
        ?.catch(() => {});
    }

    return {
      success: true,
      agentResponse,
      interactionId: resultMessage.messageId,
    };
  }

  /**
   * Whether this reply should carry the one-time "you can mute me" hint.
   *
   * True only on the bot's FIRST reply in a channel thread — sticky auto-reply
   * (and thus muting) exists only in channels, and claimThreadMuteHint ensures
   * the hint rides a single reply per thread rather than every one.
   */
  private async shouldHintThreadMute(
    provider: ChatOpsProvider,
    message: IncomingChatMessage,
  ): Promise<boolean> {
    if (message.metadata?.conversationType !== "channel" || !message.threadId) {
      return false;
    }
    return await claimThreadMuteHint({
      provider: provider.providerId,
      channelId: message.channelId,
      threadId: message.threadId,
    });
  }

  private async replyWithApprovalForm(params: {
    agent: { id: string; name: string };
    message: IncomingChatMessage;
    provider: ChatOpsProvider;
    sendReply: boolean;
    approvalRequests: A2AArchestraApprovalRequest[];
    currentApprovalId?: string; // if replying from an approval flow
    result: A2AProtocolSendMessageResponse;
  }): Promise<ChatOpsProcessingResult> {
    const {
      agent,
      message,
      provider,
      sendReply,
      approvalRequests,
      currentApprovalId,
      result,
    } = params;
    const { task } = result;
    if (!task) {
      // This should never happen — approval requests are only returned in task metadata
      throw new Error(
        "[ChatOps] Expected task with approval requests in A2A response",
      );
    }

    const isNewApprovalRequestBatch =
      !currentApprovalId ||
      !approvalRequests.find((req) => req.approvalId === currentApprovalId);
    const resultMessage = extractMessageFromSendMessageResult(result);

    if (!isNewApprovalRequestBatch) {
      const unresolvedCount = approvalRequests.filter(
        (req) => !req.resolved,
      ).length;
      await provider.sendReply({
        originalMessage: message,
        text: `Pending approval requests: ${unresolvedCount}`,
        footer: buildAgentFooter(agent.name),
        conversationReference: message.metadata?.conversationReference,
      });
      return {
        success: true,
        agentResponse: "",
        interactionId: resultMessage.messageId,
      };
    }

    const agentResponse = stripThinkingBlocks(
      (resultMessage?.parts || []).map((p) => p.text).join("\n"),
    );

    if (sendReply) {
      await provider.sendReply({
        originalMessage: message,
        text:
          agentResponse ||
          "Approval required before I can continue with this action.",
        footer: buildAgentFooter(agent.name),
        conversationReference: message.metadata?.conversationReference,
      });

      for (const approvalRequest of approvalRequests) {
        // `run_tool` is a meta wrapper; show the user the underlying tool and
        // its arguments rather than the opaque wrapper name.
        const { toolName, toolInput } = resolveRunToolTarget(
          approvalRequest.toolName,
          approvalRequest.toolInput,
        );
        await provider.addApprovalRequestForm({
          approvalId: approvalRequest.approvalId,
          taskId: task.id,
          channelId: message.channelId,
          threadId: message.threadId,
          toolName,
          toolArgs: toolInput,
          originalMessage: message,
        });
      }
    }

    return {
      success: true,
      agentResponse,
      interactionId: resultMessage.messageId,
    };
  }

  async executeMessage(params: {
    agent: { id: string; name: string };
    binding: { id: string; organizationId: string };
    message: IncomingChatMessage;
    provider: ChatOpsProvider;
    fullMessage: string;
    userId: string;
    /**
     * Conversation-backed mode (the normal path): the thread's persisted
     * conversation id, the access-filtered prior history, and the message id
     * the persisted user turn was written with.
     */
    conversationTurn?: {
      conversationId: string;
      conversationHistory: ChatMessage[];
      requestMessageId: string;
    };
  }): Promise<{
    result: A2ASendMessageResult;
    responseAgent: { id: string; name: string };
  }> {
    const {
      agent,
      binding,
      message,
      provider,
      fullMessage,
      userId,
      conversationTurn,
    } = params;

    // Use thread ID (or channel ID for non-threaded messages) as session ID
    // so all messages in the same thread are grouped together in logs
    const sessionId = buildChatOpsSessionId(
      provider.providerId,
      message.channelId,
      message.threadId,
    );
    const effectiveThreadId =
      message.threadId ?? message.channelId ?? message.messageId;

    const request = buildSendMessageRequest({
      messageId: conversationTurn?.requestMessageId,
      parts: [
        { text: fullMessage },
        ...buildAttachmentsMessageParts(message.attachments || []),
      ],
    });
    const source: InteractionSource =
      CHATOPS_PROVIDER_SOURCES[provider.providerId];
    const systemParams = {
      sessionId,
      source,
      routeCategory: RouteCategory.CHATOPS,
      chatOpsBindingId: binding.id,
      chatOpsThreadId: effectiveThreadId,
      conversationId: conversationTurn?.conversationId,
      // ChatMessage is the persisted, structurally UIMessage-compatible shape.
      conversationHistory: conversationTurn?.conversationHistory as
        | UIMessage[]
        | undefined,
    };

    const initialResult = await this.a2aManager.sendMessage({
      actor: {
        kind: "user",
        id: userId,
        organizationId: binding.organizationId,
      },
      agentId: agent.id,
      request,
      systemParams,
    });

    // If swap_agent/swap_to_default_agent created a thread-level override
    // during execution, hand off to the new agent in the same chatops turn
    // only when the routing agent did not already produce a visible reply.
    const postExecOverride = await ChatOpsThreadAgentOverrideModel.findByThread(
      binding.id,
      effectiveThreadId,
    );

    if (postExecOverride && postExecOverride.agentId !== agent.id) {
      const swappedAgent = await AgentModel.findById(postExecOverride.agentId);
      if (swappedAgent && swappedAgent.agentType === "agent") {
        const initialResponseTextIsEmpty =
          stripThinkingBlocks(
            (
              extractMessageFromSendMessageResult(initialResult.response)
                ?.parts || []
            )
              .map((p) => p.text)
              .join("\n"),
          ) === "";
        const initialResponseNoApprovalRequests =
          !extractApprovalRequestsFromSendMessageResult(initialResult.response)
            ?.length;
        const initialResponseIsEmpty =
          initialResponseTextIsEmpty && initialResponseNoApprovalRequests;

        if (!initialResponseIsEmpty) {
          await this.syncConversationAgent({
            conversationId: conversationTurn?.conversationId,
            organizationId: binding.organizationId,
            swappedAgent,
            userId,
          });
          return {
            result: initialResult,
            responseAgent: {
              id: swappedAgent.id,
              name: swappedAgent.name,
            },
          };
        }

        logger.info(
          {
            bindingId: binding.id,
            threadId: effectiveThreadId,
            previousAgentId: agent.id,
            swappedAgentId: swappedAgent.id,
          },
          "[ChatOps] Thread agent override detected, handing off to swapped agent",
        );

        await this.syncConversationAgent({
          conversationId: conversationTurn?.conversationId,
          organizationId: binding.organizationId,
          swappedAgent,
          userId,
        });

        const handoffResult = await this.a2aManager.sendMessage({
          actor: {
            kind: "user",
            id: userId,
            organizationId: binding.organizationId,
          },
          agentId: swappedAgent.id,
          request,
          systemParams,
        });

        return {
          result: handoffResult,
          responseAgent: {
            id: swappedAgent.id,
            name: swappedAgent.name,
          },
        };
      }
    }

    return { result: initialResult, responseAgent: agent };
  }

  async handleInteractiveApprovalDecision(
    provider: ChatOpsProvider,
    decision: ChatOpsApprovalDecision,
    updateApprovalRequestCallback?: () => Promise<void> | void,
  ): Promise<void> {
    try {
      const email =
        decision.approverEmail ??
        (await provider.getUserEmail(decision.userId));

      const user = await UserModel.findByEmail(email?.toLowerCase() || "");
      if (!user) {
        logger.error(
          { userId: decision.userId, email },
          "[ChatOps] Could not resolve user for approval decision",
        );
        return;
      }

      if (
        email?.toLowerCase() !==
        decision.originalMessage.senderEmail?.toLowerCase()
      ) {
        // Only initial requester can approve/decline
        return;
      }

      const binding = await ChatOpsChannelBindingModel.findByChannel({
        provider: provider.providerId,
        channelId: decision.channelId,
        workspaceId: decision.workspaceId,
      });

      if (!binding) {
        logger.error(
          { channelId: decision.channelId, workspaceId: decision.workspaceId },
          "[ChatOps] No channel binding found for approval decision",
        );
        return;
      }
      if (!binding.agentId) {
        logger.error(
          {
            bindingId: binding.id,
            channelId: decision.channelId,
            workspaceId: decision.workspaceId,
          },
          "[ChatOps] Channel binding has no agent for approval decision",
        );
        return;
      }

      const agent = await AgentModel.findById(binding.agentId);
      if (!agent) {
        logger.error(
          { bindingId: binding.id, agentId: binding.agentId },
          "[ChatOps] Could not find agent for approval decision",
        );
        return;
      }

      const originalMessage = decision.originalMessage as IncomingChatMessage;

      if (provider.setTypingStatus) {
        await provider
          .setTypingStatus(
            originalMessage.channelId,
            originalMessage.threadId ?? "",
            originalMessage.metadata,
          )
          .catch(() => {});
      }

      // Approval continuation runs against the thread's persisted
      // conversation like any other turn: same lock, same conversation-backed
      // execution scope, and the approval-request row updated in place.
      // The approval card is only mutated AFTER the lock is held — on
      // contention the buttons must stay actionable so the decision can be
      // retried.
      const effectiveThreadId =
        originalMessage.threadId ??
        originalMessage.channelId ??
        originalMessage.messageId;
      const mapping =
        await ChatOpsThreadConversationModel.findByBindingAndThread(
          binding.id,
          effectiveThreadId,
        );
      const conversation = mapping
        ? await ConversationModel.findByIdInOrganization({
            id: mapping.conversationId,
            organizationId: binding.organizationId,
          })
        : null;

      let runLock = null;
      if (conversation) {
        runLock = await ActiveChatRunModel.create({
          conversationId: conversation.id,
          userId: user.id,
          organizationId: binding.organizationId,
        });
        if (!runLock) {
          await provider.sendReply({
            originalMessage,
            text: "The agent is already responding to this conversation — try the approval again once it finishes.",
            footer: buildAgentFooter(agent.name),
            conversationReference:
              originalMessage.metadata?.conversationReference,
          });
          return;
        }
      }

      let runStatus: "completed" | "failed" = "failed";
      const heartbeat = runLock
        ? setInterval(() => {
            void ActiveChatRunModel.touch(runLock.id).catch(() => {});
          }, CHATOPS_RUN_HEARTBEAT_MS)
        : null;
      try {
        if (updateApprovalRequestCallback) {
          await updateApprovalRequestCallback();
        } else {
          await provider.updateApprovalRequest({
            channelId: decision.channelId,
            messageKey: decision.messageTs,
            toolName: decision.toolName,
            approved: decision.approved,
          });
        }

        const result = await this.a2aManager.sendMessage({
          actor: {
            kind: "user" as const,
            id: user.id,
            organizationId: binding.organizationId,
          },
          agentId: binding.agentId,
          request: buildApprovalDecisionSendMessageRequest({
            taskId: decision.taskId,
            approvalDecisions: [
              {
                approvalId: decision.approvalId,
                approved: decision.approved,
              },
            ],
          }),
          systemParams: {
            sessionId: buildChatOpsSessionId(
              provider.providerId,
              decision.channelId,
              originalMessage.threadId,
            ),
            source: CHATOPS_PROVIDER_SOURCES[provider.providerId],
            routeCategory: RouteCategory.CHATOPS,
            chatOpsBindingId: binding.id,
            chatOpsThreadId: effectiveThreadId,
            conversationId: conversation?.id,
          },
        });

        // The decision mutated the approval-request assistant message; the
        // persisted row is updated in place so web never shows stale
        // pending-tool state.
        if (conversation && result.responseUiMessage) {
          await persistChatOpsAssistantTurn({
            conversationId: conversation.id,
            assistantMessage: result.responseUiMessage,
            provider: provider.providerId,
            contextScope:
              conversation.userId === user.id || binding.isDm === true
                ? "full"
                : "provider",
          });
        }

        runStatus = "completed";
        await this.replyByMessageExecutionResult({
          agent,
          message: originalMessage,
          provider,
          sendReply: true,
          currentApprovalId: decision.approvalId,
          result: result.response,
          conversationId: conversation?.id,
        });
      } finally {
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        if (runLock) {
          await ActiveChatRunModel.markTerminal({
            runId: runLock.id,
            status: runStatus,
          });
        }
      }
    } catch (error) {
      logger.error(
        {
          error: errorMessage(error),
          channelId: decision.channelId,
          workspaceId: decision.workspaceId,
        },
        "[ChatOps] Failed to execute approval decision",
      );

      await this.sendExecutionErrorReply({
        provider,
        message: decision.originalMessage,
        error,
      });
    }
  }
}

export const chatOpsManager = new ChatOpsManager();

// =============================================================================
// Internal Helpers
// =============================================================================

/** User-facing label for an LLM provider API key's visibility scope. */
const LLM_KEY_SCOPE_LABELS: Record<ResourceVisibilityScope, string> = {
  personal: "personal",
  team: "team",
  org: "organization-wide",
};

async function getDefaultOrganizationId(): Promise<string> {
  const org = await OrganizationModel.getFirst();
  if (!org) {
    throw new Error("No organizations found");
  }
  return org.id;
}

/** Human-readable provider names for LLM context prefixes. */
const CHATOPS_PROVIDER_LABELS: Record<ChatOpsProviderType, string> = {
  slack: "Slack",
  "ms-teams": "MS Teams",
  telegram: "Telegram",
};

/** Interaction-log `source` value per provider. */
// Under the stale-run reaper's 10-minute threshold with margin.
const CHATOPS_RUN_HEARTBEAT_MS = 4 * 60 * 1000;

const CHATOPS_PROVIDER_SOURCES: Record<ChatOpsProviderType, InteractionSource> =
  {
    slack: "chatops:slack",
    "ms-teams": "chatops:ms-teams",
    telegram: "chatops:telegram",
  };

/**
 * Build a deterministic session ID for chatops messages.
 * Uses the thread ID when available (threaded conversations), otherwise
 * falls back to the channel ID (non-threaded DMs/channels).
 * Prefixed with provider to avoid collisions across providers.
 *
 * MS Teams DM channel IDs can be 100+ chars. Long session IDs overflow the
 * 128-char Prometheus exemplar label budget, so we hash identifiers that
 * would push the total past a safe length.
 * @public — exported for testability
 */
export function buildChatOpsSessionId(
  providerId: string,
  channelId: string,
  threadId?: string,
): string {
  const id = threadId ?? channelId;
  const prefix = `chatops:${providerId}:`;
  if (prefix.length + id.length <= MAX_SESSION_ID_LENGTH) {
    return `${prefix}${id}`;
  }
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 16);
  return `${prefix}${hash}`;
}

// Prometheus exemplar labels allow 128 UTF-8 chars total (keys + values).
// traceID (7+32) + spanID (6+16) = 61; remaining for sessionID key (9) + value = 58.
const MAX_SESSION_ID_LENGTH = 58;

/**
 * Codes worth one immediate application-level retry: transient conditions
 * where a second attempt plausibly succeeds right away. RateLimit is
 * deliberately excluded even though it's retryable — the SDK already backed
 * off within the failed attempt, so an immediate re-run would just re-hit the
 * same window.
 */
const CHATOPS_AUTO_RETRYABLE_CODES = new Set<ChatErrorCode>([
  ChatErrorCode.ServerError,
  ChatErrorCode.NetworkError,
  ChatErrorCode.EmptyResponse,
  ChatErrorCode.IncompleteToolCall,
]);

function isTransientProviderError(error: unknown): error is ProviderError {
  return (
    error instanceof ProviderError &&
    error.chatErrorResponse.isRetryable &&
    CHATOPS_AUTO_RETRYABLE_CODES.has(error.chatErrorResponse.code)
  );
}

/**
 * Strip bot footer from message text to avoid the LLM repeating it.
 * Handles the "🤖 AgentName" footer in markdown (Teams) and plain text (Slack) formats.
 */
function stripBotFooter(text: string): string {
  return text
    .replace(/\n\n---\n+🤖 .+$/i, "")
    .replace(/\n🤖 .+$/, "")
    .trim();
}

/**
 * Check if a given input string matches an agent name.
 * Tolerant matching: case-insensitive, ignores spaces.
 * E.g., "AgentPeter", "agent peter", "agentpeter" all match "Agent Peter".
 *
 * @public — exported for testability
 */
export function matchesAgentName(input: string, agentName: string): boolean {
  const normalizedInput = input.toLowerCase().replace(/\s+/g, "");
  const normalizedName = agentName.toLowerCase().replace(/\s+/g, "");
  return normalizedInput === normalizedName;
}
