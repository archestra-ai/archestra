import { createHash } from "node:crypto";
import {
  ChatErrorCode,
  DEFAULT_APP_NAME,
  type MessagingChannelId,
  providerDisplayNames,
  type ResourceVisibilityScope,
} from "@archestra/shared";
import { A2AManager, type A2ASystemParams } from "@/agents/a2a/a2a-manager";
import type { A2AAttachment } from "@/agents/a2a-executor";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { resolveRunToolTarget } from "@/archestra-mcp-server/run-tool-target";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import {
  AgentChatOpsBotModel,
  AgentModel,
  ChatOpsBotModel,
  ChatOpsChannelBindingModel,
  ChatOpsConfigModel,
  ChatOpsProcessedMessageModel,
  ChatOpsThreadContextModel,
  LlmProviderApiKeyModel,
  OrganizationModel,
  TeamModel,
  UserModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { RouteCategory } from "@/observability/tracing";
import { ProviderError, SubagentProviderError } from "@/routes/chat/errors";
import { getHiddenMessagingChannels } from "@/services/integration-overrides";
import { ResourcePermissions } from "@/services/resource-permissions";
import type {
  ChatOpsApprovalDecision,
  ChatOpsConnectionMode,
  ChatOpsProcessingResult,
  ChatOpsProvider,
  ChatOpsProviderType,
  IncomingChatMessage,
  SkippedAttachment,
} from "@/types";
import type { ChatOpsBot } from "@/types/chatops-bot";
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
import { A2AContextManager } from "../a2a/a2a-model-manager";
import type {
  A2AArchestraApprovalRequest,
  A2AProtocolSendMessageResponse,
} from "../a2a/a2a-protocol";
import {
  buildWelcomeMessage,
  ensureProvisionedUser,
  resolveSignupWelcomeMode,
} from "./auto-provision";
import { claimThreadMuteHint, getThreadMuteMarker } from "./channel-activation";
import { compactChatOpsResponse } from "./chatops-response";
import { chatOpsRunRegistry } from "./chatops-run-registry";
import {
  CHATOPS_ATTACHMENT_LIMITS,
  CHATOPS_CHANNEL_DISCOVERY,
  CHATOPS_CONTEXT_COMPACTED_NOTICE,
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
  buildChannelInstructionsBlock,
  buildHistorySkippedAttachmentsNote,
  buildSkippedAttachmentsNote,
  errorMessage,
  isLlmProviderAuthError,
  isSlackDmChannel,
  stripAgentFooterChrome,
} from "./utils";

/**
 * ChatOps Manager - handles chatops provider lifecycle and message processing
 * @public — exported for testability
 */
export class ChatOpsManager {
  private msTeamsProvider: MSTeamsProvider | null = null;
  /** One provider per Slack App, keyed by bot id, in creation order. */
  private slackProviders = new Map<string, SlackProvider>();
  private telegramProvider: TelegramProvider | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly a2aManager: A2AManager;
  private readonly statefulA2aManager: A2AManager;

  constructor() {
    this.a2aManager = new A2AManager({
      stateless: true,
    });
    // Server-side-session providers (Telegram — no platform history API) run
    // stateful: each thread's messages persist in its A2A context, shared by
    // every participant. Access control happens in this manager
    // (validateUserAccess), so the per-actor context ownership check is
    // skipped via trustedContextAccess.
    this.statefulA2aManager = new A2AManager({
      trustedContextAccess: true,
    });
  }

  getMSTeamsProvider(): MSTeamsProvider | null {
    return this.msTeamsProvider;
  }

  /** The running provider of one Slack App, or null when it is not running. */
  getSlackProvider(botId: string): SlackProvider | null {
    return this.slackProviders.get(botId) ?? null;
  }

  /** Slack App #1: what the original single webhook URLs resolve to. */
  getDefaultSlackProvider(): SlackProvider | null {
    return this.slackProviders.values().next().value ?? null;
  }

  getSlackProviders(): SlackProvider[] {
    return [...this.slackProviders.values()];
  }

  getTelegramProvider(): TelegramProvider | null {
    return this.telegramProvider;
  }

  /** The running provider behind a bot, whatever its provider type. */
  getProviderForBot(botId: string): ChatOpsProvider | null {
    return (
      this.slackProviders.get(botId) ??
      [this.msTeamsProvider, this.telegramProvider].find(
        (provider) => provider?.botId === botId,
      ) ??
      null
    );
  }

  /**
   * Offer only agents the resolved organization member can use. An unresolved
   * sender receives no resource names. A shared channel is never offered a
   * personal agent; a direct message is. Execution checks the grant again for
   * each message.
   */
  async getAccessibleChatopsAgents({
    senderEmail,
    isDm,
    botId,
  }: {
    senderEmail?: string;
    isDm: boolean;
    botId?: string;
  }): Promise<{ id: string; name: string }[]> {
    const user = senderEmail
      ? await UserModel.findByEmail(senderEmail.toLowerCase())
      : null;

    if (!user) return [];
    const org = await OrganizationModel.getFirst();
    if (!org) return [];
    const usable = await AgentModel.findUsableChatopsAgents({
      organizationId: org.id,
      userId: user.id,
      includePersonal: isDm,
    });
    // A bot only ever offers the agents that use it. A bot no agent uses yet
    // behaves as before and offers every usable agent.
    const holders = botId ? await this.getAgentsUsingBot(botId) : [];
    if (holders.length === 0) return usable;
    const holderIds = new Set(holders.map((agent) => agent.id));
    return usable.filter((agent) => holderIds.has(agent.id));
  }

  async getAgentsUsingBot(
    botId: string,
  ): Promise<{ id: string; name: string }[]> {
    return await AgentChatOpsBotModel.findAgentsByBot(botId);
  }

  /**
   * Whether `userId` is the bot user of another Slack App running here. Used to
   * tell "addressed to the other bot" from "addressed to nobody".
   */
  isOtherManagedBotUser(params: { botId: string; userId: string }): boolean {
    return this.getSlackProviders().some(
      (provider) =>
        provider.botId !== params.botId &&
        provider.getBotUserId() === params.userId,
    );
  }

  /**
   * Check if any chatops provider is configured and enabled.
   */
  isAnyProviderConfigured(): boolean {
    return (
      (this.msTeamsProvider?.isConfigured() ?? false) ||
      this.getSlackProviders().some((provider) => provider.isConfigured()) ||
      (this.telegramProvider?.isConfigured() ?? false)
    );
  }

  /**
   * Discover all channels in a workspace and upsert them as bindings.
   * Uses a distributed TTL cache to avoid rediscovering too frequently.
   * Providers implement channel listing; this method handles caching, upsert, and stale cleanup.
   */
  /**
   * Post one message into a bound channel's thread, outside any incoming
   * message flow. This is how background work started FROM a chatops
   * conversation (a runner task) reports back when it finishes — the promise
   * "I'll follow up once it completes" only means something if something can
   * actually follow up.
   */
  /**
   * Upload a file into a bound channel thread (a task's demo recording, for
   * example) so it renders natively. Throws with a caller-visible reason when
   * the binding is gone, the provider is down, or it has no file API — an
   * agent-facing tool needs the failure, not a log line.
   */
  async uploadFileToBindingThread(params: {
    bindingId: string;
    threadId: string;
    filename: string;
    data: Buffer;
    comment?: string;
  }): Promise<void> {
    const binding = await ChatOpsChannelBindingModel.findById(params.bindingId);
    if (!binding) {
      throw new Error("The task's messaging-channel binding no longer exists");
    }
    // Delayed output leaves through the bot that started the work. A stopped or
    // removed bot fails loudly here; there is deliberately no fallback to
    // another bot of the same provider.
    const provider = this.getProviderForBot(binding.botId);
    if (!provider?.isConfigured()) {
      throw new Error(
        `The ${binding.provider} bot that started this task is not running`,
      );
    }
    if (!provider.uploadFileToThread) {
      throw new Error(
        `The ${binding.provider} provider does not support file uploads`,
      );
    }
    await provider.uploadFileToThread({
      channelId: binding.channelId,
      threadId: params.threadId,
      filename: params.filename,
      data: params.data,
      comment: params.comment,
    });
  }

  async notifyBindingThread(params: {
    bindingId: string;
    threadId: string;
    text: string;
    agentName?: string;
  }): Promise<void> {
    const binding = await ChatOpsChannelBindingModel.findById(params.bindingId);
    if (!binding) {
      logger.warn(
        { bindingId: params.bindingId },
        "[ChatOps] notifyBindingThread: binding no longer exists",
      );
      return;
    }
    // Delayed output leaves through the bot that started the work. A stopped or
    // removed bot is reported here; there is deliberately no fallback to
    // another bot of the same provider.
    const provider = this.getProviderForBot(binding.botId);
    if (!provider?.isConfigured()) {
      logger.warn(
        {
          bindingId: params.bindingId,
          provider: binding.provider,
          botId: binding.botId,
        },
        "[ChatOps] notifyBindingThread: the bot that started this task is not running",
      );
      return;
    }
    await provider.sendReply({
      // A synthesized reference, not a real incoming message: sendReply only
      // routes on channelId/threadId, and this reply answers a thread rather
      // than a specific message.
      originalMessage: {
        messageId: `notify-${params.bindingId}-${Date.now()}`,
        channelId: binding.channelId,
        workspaceId: null,
        threadId: params.threadId,
        senderId: "system",
        senderName: "system",
        text: "",
        rawText: "",
        timestamp: new Date(),
        isThreadReply: true,
      },
      text: params.text,
      replyInThread: true,
      footer: params.agentName ? `🤖 ${params.agentName}` : undefined,
    });
  }

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
      `${CacheKey.ChannelDiscovery}-${provider.providerId}-${provider.botId}-${workspaceId}` as AllowedCacheKey;
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
        botId: provider.botId,
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
          botId: provider.botId,
          workspaceIds,
          activeChannelIds,
        },
      );

      // Clean up duplicate bindings for the same channel caused by different
      // workspaceId formats (UUID vs thread ID) stored at different times.
      await ChatOpsChannelBindingModel.deduplicateBindings({
        provider: provider.providerId,
        botId: provider.botId,
        channelIds: activeChannelIds,
      });

      // Set TTL cache only after successful discovery
      await cacheManager.set(cacheKey, true, CHATOPS_CHANNEL_DISCOVERY.TTL_MS);

      logger.info(
        {
          botId: provider.botId,
          workspaceId,
          channelCount: channels.length,
          deletedCount,
        },
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
    const organization = await OrganizationModel.getFirst();
    if (!organization) {
      logger.warn(
        "[ChatOps] No organization exists yet, skipping messaging provider initialization",
      );
      return;
    }
    const organizationId = organization.id;

    // Seed DB from env vars on first run (no-op if DB already has config)
    await this.seedConfigFromEnvVars(organizationId);

    // Load configs from DB (the single source of truth)
    // Errors are caught individually so a single broken config doesn't prevent other providers from initializing
    const [msTeamsConfig, slackBots, telegramConfig] = await Promise.all([
      ChatOpsConfigModel.getMsTeamsConfig().catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "[ChatOps] Failed to load MS Teams config, skipping",
        );
        return null;
      }),
      ChatOpsBotModel.findByProvider({ organizationId, provider: "slack" }),
      ChatOpsConfigModel.getTelegramConfig().catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "[ChatOps] Failed to load Telegram config, skipping",
        );
        return null;
      }),
    ]);
    const slackConfigs = await Promise.all(
      slackBots.map(async (bot) => ({
        bot,
        config: await ChatOpsConfigModel.getSlackConfig(bot).catch((error) => {
          logger.error(
            {
              botId: bot.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "[ChatOps] Failed to load Slack config, skipping",
          );
          return null;
        }),
      })),
    );

    // A channel an admin switched off must actually stop listening — a bot
    // left running would keep answering messages the organization no longer
    // allows that channel to carry.
    //
    // Deliberately fail-open, unlike the inbound email webhook: a webhook's
    // sender retries, so deferring one delivery costs nothing, while this runs
    // once at startup with no retry behind it — failing closed would take every
    // chat channel offline until someone restarts or saves a config. The
    // window is also narrow: a database the overrides cannot be read from is
    // one the config loads above already failed on, leaving nothing to start.
    const hiddenChannels = await getHiddenMessagingChannels().catch((error) => {
      logger.error(
        { error: errorMessage(error) },
        "[ChatOps] Failed to load messaging channel overrides, treating all channels as enabled",
      );
      return new Set<MessagingChannelId>();
    });

    // Create providers with their config. Teams and Telegram keep one org-level
    // bot each; every Slack App gets its own provider.
    if (msTeamsConfig && !hiddenChannels.has("ms-teams")) {
      const bot = await this.ensureSingletonBot({
        organizationId,
        provider: "ms-teams",
      });
      this.msTeamsProvider = new MSTeamsProvider(msTeamsConfig, bot.id);
      this.msTeamsProvider.setEventHandler(this);
    }
    if (!hiddenChannels.has("slack")) {
      for (const { bot, config: slackConfig } of slackConfigs) {
        if (!slackConfig) continue;
        const slackProvider = new SlackProvider(slackConfig, bot.id);
        // Wire event handler so the provider can dispatch socket events and
        // access manager capabilities (e.g., getAccessibleChatopsAgents for slash commands)
        slackProvider.setEventHandler(this);
        this.slackProviders.set(bot.id, slackProvider);
      }
    }
    // The Telegram integration is feature-flagged: without the master switch
    // the provider never starts, even if the DB already holds a config.
    if (
      telegramConfig &&
      config.chatops.telegramEnabled &&
      !hiddenChannels.has("telegram")
    ) {
      const bot = await this.ensureSingletonBot({
        organizationId,
        provider: "telegram",
      });
      this.telegramProvider = new TelegramProvider(telegramConfig, bot.id);
      // Telegram delivers everything over long polling, so all events flow
      // through the event handler (like Slack socket mode)
      this.telegramProvider.setEventHandler(this);
    }

    if (!this.isAnyProviderConfigured()) {
      return;
    }

    const providers: {
      name: string;
      provider: ChatOpsProvider | null;
      slackBot?: ChatOpsBot;
    }[] = [
      { name: "MS Teams", provider: this.msTeamsProvider },
      ...slackBots.flatMap((bot) => {
        const provider = this.slackProviders.get(bot.id) ?? null;
        return provider
          ? [{ name: `Slack (${bot.name})`, provider, slackBot: bot }]
          : [];
      }),
      { name: "Telegram", provider: this.telegramProvider },
    ];

    for (const { name, provider, slackBot } of providers) {
      if (provider?.isConfigured()) {
        try {
          await provider.initialize();
          if (slackBot) {
            await this.pinSlackIdentity(slackBot);
          }
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
      // A provider refused by the identity check above is no longer running.
      if (provider && workspaceId && this.getProviderForBot(provider.botId)) {
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

  /**
   * (Re)start one Slack App without touching the others: a saved token change
   * or a newly created app must not drop another app's socket connection.
   * Throws when the app is configured but cannot start (bad token, identity
   * mismatch), so the caller can tell the admin instead of leaving a silent,
   * half-running app behind.
   */
  async startSlackApp(botId: string): Promise<void> {
    await this.stopSlackProvider(botId);

    const bot = await ChatOpsBotModel.findById(botId);
    if (!bot || bot.provider !== "slack") return;
    const hiddenChannels = await getHiddenMessagingChannels().catch(
      () => new Set<MessagingChannelId>(),
    );
    if (hiddenChannels.has("slack")) return;
    const slackConfig = await ChatOpsConfigModel.getSlackConfig(bot);
    if (!slackConfig) return;

    const slackProvider = new SlackProvider(slackConfig, bot.id);
    slackProvider.setEventHandler(this);
    this.slackProviders.set(bot.id, slackProvider);
    if (!slackProvider.isConfigured()) return;

    try {
      await slackProvider.initialize();
      await this.pinSlackIdentity(bot);
    } catch (error) {
      // A refused identity already removed the provider; an authentication
      // failure leaves it registered but not running, like at startup.
      logger.error(
        { botId, error: errorMessage(error) },
        "[ChatOps] Failed to start Slack App",
      );
      throw error;
    }
    const workspaceId = slackProvider.getWorkspaceId();
    if (workspaceId) {
      this.discoverChannels({
        provider: slackProvider,
        context: null,
        workspaceId,
      }).catch((error) => {
        logger.warn(
          { botId, error: errorMessage(error) },
          "[ChatOps] Initial Slack channel discovery failed",
        );
      });
    }
    this.startProcessedMessageCleanup();
  }

  /** Stop one Slack App's provider (removal, or before a restart). */
  async stopSlackApp(botId: string): Promise<void> {
    await this.stopSlackProvider(botId);
  }

  async cleanup(): Promise<void> {
    if (this.msTeamsProvider) {
      await this.msTeamsProvider.cleanup();
      this.msTeamsProvider = null;
    }
    for (const slackProvider of this.slackProviders.values()) {
      await slackProvider.cleanup();
    }
    this.slackProviders.clear();
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

    const organizationId = await getDefaultOrganizationId();

    // Check for existing binding
    let binding = await ChatOpsChannelBindingModel.findByChannel({
      provider: provider.providerId,
      botId: provider.botId,
      channelId: message.channelId,
      workspaceId: message.workspaceId,
    });

    // If no binding found and this is a DM, check for a pending DM binding
    // (pre-assigned from the UI before the first real DM interaction)
    const isDm = message.metadata?.channelType === "im";
    if (!binding && isDm && message.senderEmail) {
      const pending = await ChatOpsChannelBindingModel.findPendingDmBinding({
        organizationId,
        provider: provider.providerId,
        botId: provider.botId,
        dmOwnerEmail: message.senderEmail,
      });
      if (pending) {
        binding = await ChatOpsChannelBindingModel.fulfillDmBinding({
          id: pending.id,
          organizationId,
          realChannelId: message.channelId,
          workspaceId: message.workspaceId,
        });
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
      const existingDm =
        await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
          organizationId,
          provider: provider.providerId,
          botId: provider.botId,
          dmOwnerEmail: message.senderEmail,
        });
      if (existingDm) {
        binding = await ChatOpsChannelBindingModel.fulfillDmBinding({
          id: existingDm.id,
          organizationId,
          realChannelId: message.channelId,
          workspaceId: message.workspaceId,
        });
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
        binding = await ChatOpsChannelBindingModel.upsertByChannel({
          organizationId,
          provider: provider.providerId,
          botId: provider.botId,
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

    // A bare mention can arrive as either app_mention or message; ingress
    // dedup keeps the first, so both forms must produce the same reply.
    const isEmptySlackMention =
      provider.providerId === "slack" &&
      (message.metadata?.eventType === "app_mention" ||
        message.metadata?.botMentioned === true) &&
      !message.text.trim();
    if (isEmptySlackMention) {
      // Deduplicate this early-return path so Slack retries don't produce duplicate replies.
      const isNew = await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
        botId: provider.botId,
        messageId: message.messageId,
      });
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
      botId: provider.botId,
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
    /**
     * Whether an access failure is explained in the conversation. Pass false for
     * a message the sender never addressed to the bot — it reached us only
     * because the channel answers every message, so a public "Access Denied"
     * would be the bot interrupting a conversation it wasn't part of.
     */
    announceAccessErrors?: boolean;
  }): Promise<ChatOpsProcessingResult> {
    const {
      message,
      provider,
      sendReply = true,
      announceAccessErrors = true,
    } = params;

    // Deduplication check
    const isNew = await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
      botId: provider.botId,
      messageId: message.messageId,
    });
    if (!isNew) {
      return { success: true };
    }

    // Look up channel binding
    const binding = await ChatOpsChannelBindingModel.findByChannel({
      provider: provider.providerId,
      botId: provider.botId,
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

    // Resolve inline agent mention
    const { agentToUse, cleanedMessageText, refusal } =
      await this.resolveInlineAgentMention({
        messageText: message.text,
        defaultAgent: agent,
        botId: provider.botId,
      });
    if (refusal) {
      if (sendReply) {
        await provider.sendReply({ originalMessage: message, text: refusal });
      }
      return { success: true };
    }

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
      announceAccessErrors,
    });

    if (!authResult.success) {
      return { success: false, error: authResult.error };
    }

    // Build context from thread history (includes downloading historical
    // image attachments). Server-side-session providers skip the platform
    // fetch: their history lives in the thread's persistent A2A context and
    // reaches the model as real prior turns instead of a text block.
    const serverSideSessions = provider.usesServerSideSessions === true;
    const { contextMessages, historyAttachments } = serverSideSessions
      ? { contextMessages: [], historyAttachments: [] }
      : await this.fetchThreadHistory(message, provider);

    // Build the full message with context — use cleanedMessageText so
    // the "AgentName >" prefix is stripped from what the LLM sees
    const providerLabel = CHATOPS_PROVIDER_LABELS[provider.providerId];
    const threadRootTs = message.threadId ?? message.messageId;
    // The channel's NAME, not just its id. Agent instructions are routinely
    // scoped by name — for example, "in #support-triage, hand the task to the
    // incident worker" — and the framing used to carry only the opaque channel
    // id, so a rule like that was unverifiable. The binding already carries the
    // name (it is what the channels table renders); it just never reached the
    // model.
    const channelLabel = binding.isDm
      ? null
      : (binding.channelName?.trim() ?? null) || null;
    let systemPrefix = channelLabel
      ? `(${providerLabel} conversation in "${channelLabel}", thread id: ${threadRootTs})`
      : `(${providerLabel} conversation, thread id: ${threadRootTs})`;
    if (provider.providerId === "slack") {
      // Link to the message that actually triggered this run rather than the
      // thread root: Slack builds a reply's permalink with ?thread_ts=<root>,
      // so one lookup carries both, while the root's permalink loses the reply.
      const permalinkTs = message.messageId || threadRootTs;
      const permalink = provider.getMessagePermalink
        ? await provider.getMessagePermalink({
            channelId: message.channelId,
            messageId: permalinkTs,
          })
        : null;
      // Surface BOTH timestamps, each labelled. Only the thread root used to be
      // here, so a run triggered by a thread reply gave the model no way to name
      // the message it was actually answering — tools handed a channel+ts pair
      // then anchored to the thread opener instead of the triggering message.
      const contextLines = [
        `Slack conversation context:`,
        // Name first: it is the one line here a human-written instruction is
        // likely to key on, and the only one the model cannot derive.
        ...(channelLabel
          ? [`- Channel: #${channelLabel}`]
          : binding.isDm
            ? [`- Channel: a direct message`]
            : []),
        `- Channel ID: ${message.channelId}`,
      ];
      if (message.messageId) {
        contextLines.push(
          `- Message ts: ${message.messageId} (the message that triggered this run — use this one to refer to "this message")`,
        );
      }
      contextLines.push(
        `- Thread message ts: ${threadRootTs} (the first message of the thread)`,
      );
      if (message.workspaceId) {
        contextLines.push(`- Workspace ID: ${message.workspaceId}`);
      }
      if (permalink) {
        contextLines.push(`- Message permalink: ${permalink}`);
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
      // Only the platform's own bot answers to it: a second Slack App has a
      // name of its own and is never told it is called Archestra.
      const platformName = this.isPrimaryBot(provider)
        ? (await OrganizationModel.getById(agent.organizationId))?.appName ||
          DEFAULT_APP_NAME
        : null;
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
        `\n\nYou are "${agentToUse.name}"${botName ? ` (appearing in this chat as "${botName}")` : ""} — a bot participating in a group conversation with multiple people.${platformName ? ` People sometimes also address you as "${platformName}".` : ""}`,
        `The latest message is from ${message.senderName}.${mentionNote}`,
        `Default to replying — when in doubt, reply. Messages addressing you by ${platformName ? "any of those names" : "your name"} (with or without an @mention) are your business.`,
        ...silenceOption,
      ].join("\n");
    }

    // Per-channel instructions the admin wrote for this channel. Built here but
    // spliced in below, immediately ahead of the turn they govern, rather than
    // appended to systemPrefix: a thread's replayed history goes between the
    // two, so on systemPrefix the policy ends up separated from the message by
    // the whole conversation — read as governing the history rather than the
    // turn being answered. Keeping them off the agent's system prompt is what
    // makes them per-channel: the same agent bound to another channel never
    // sees them, and an edit applies from the next message with nothing to
    // invalidate.
    const channelInstructions = buildChannelInstructionsBlock(
      binding.channelInstructions,
    );

    // Server-side sessions persist every turn in the thread's A2A context, so
    // the stored turn stays clean — sender attribution only (needed in groups
    // where several people share the history) — while the situational framing
    // built above travels as an ephemeral prefix on the executed turn.
    // Stateless providers keep baking everything into one message.
    let fullMessage: string;
    let ephemeralExecutionPrefix: string | undefined;
    if (serverSideSessions) {
      const isGroup =
        conversationType === "groupChat" || conversationType === "channel";
      fullMessage = isGroup
        ? `${message.senderName}: ${cleanedMessageText}`
        : cleanedMessageText;
      // The A2A manager prepends this straight onto the executed turn's text,
      // so the instructions are already adjacent to the message here.
      ephemeralExecutionPrefix = `${systemPrefix}${channelInstructions}`;
    } else {
      fullMessage = `${systemPrefix}${channelInstructions}\n\n${cleanedMessageText}`;
      if (contextMessages.length > 0) {
        fullMessage = `${systemPrefix}\n\nThe earlier messages in this thread are below — this is your shared history in this conversation, so you DO have access to it and remember it. Use it to answer follow-up questions and references to "earlier", "before", or "what I just asked".\n\nConversation so far:\n${contextMessages.join("\n")}${channelInstructions}\n\nUser: ${cleanedMessageText}`;
      }
    }

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
      binding,
      message: {
        ...message,
        attachments:
          mergedAttachments.length > 0 ? mergedAttachments : undefined,
      },
      provider,
      fullMessage,
      ephemeralExecutionPrefix,
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
      const welcomeMode = await resolveSignupWelcomeMode();
      if (welcomeMode === "none") return;

      const welcome = await buildWelcomeMessage({
        mode: welcomeMode,
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
            `💡 To send me a direct message in Teams, you first need to install the ${archestraMcpBranding.appName} app personally — click **Add** when Teams prompts you.`,
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
    /** The receiving bot; the agents that use it are the only candidates. */
    botId: string;
  }): Promise<{ agentId: string; persist: boolean } | null> {
    const org = await OrganizationModel.getById(params.organizationId);

    // A bot some agents use resolves among those agents only: the org default
    // if it is one of them, else the sole one, else the picker card. A bot with
    // exactly one agent therefore answers as that agent everywhere.
    const holders = await this.getAgentsUsingBot(params.botId);
    if (holders.length > 0) {
      const preferred =
        (org?.defaultAgentId &&
          holders.find((agent) => agent.id === org.defaultAgentId)) ||
        (holders.length === 1 ? holders[0] : null);
      if (!preferred) return null;
      const agent = await AgentModel.findById(preferred.id);
      if (agent?.agentType !== "agent") return null;
      return {
        agentId: preferred.id,
        persist: (await this.channelAudience(agent)) !== "personal",
      };
    }

    // 1. Org-wide default — an explicit, shared choice; pin it to the channel.
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
        persist:
          (agent ? await this.channelAudience(agent) : null) !== "personal",
      };
    }
    return null;
  }

  /** The platform's own bot: Teams, Telegram, or the first Slack App. */
  private isPrimaryBot(provider: ChatOpsProvider): boolean {
    if (provider.providerId !== "slack") return true;
    const firstSlackApp = this.getDefaultSlackProvider();
    return !firstSlackApp || firstSlackApp.botId === provider.botId;
  }

  private async channelAudience(agent: {
    id: string;
    organizationId: string;
  }): Promise<string | null> {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    return (
      await ResourcePermissionPolicyModel.findAudience({
        organizationId: agent.organizationId,
        resource: "agent",
        scope: agent.id,
      })
    ).audience;
    // SPDX-SnippetEnd
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
      botId: provider.botId,
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
      botId: provider.botId,
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
    /** The receiving bot: only the agents that use it can be switched to. */
    botId: string;
  }): Promise<{
    agentToUse: { id: string; name: string };
    cleanedMessageText: string;
    /** Set when the prefix names an agent this bot cannot answer as. */
    refusal?: string;
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

    // A bot some agents use can only switch among those agents. Naming another
    // agent is refused rather than quietly answered by an agent that has no
    // business speaking through this bot.
    const holders = await this.getAgentsUsingBot(params.botId);
    const holderIds = new Set(holders.map((holder) => holder.id));

    // Try to find a matching agent using tolerant matching
    for (const agent of availableAgents) {
      if (matchesAgentName(potentialAgentName, agent.name)) {
        if (
          holders.length > 0 &&
          !holderIds.has(agent.id) &&
          agent.id !== defaultAgent.id
        ) {
          return {
            agentToUse: defaultAgent,
            cleanedMessageText: messageText,
            refusal:
              holders.length === 1
                ? `This bot always answers as *${holders[0].name}*, so it can't pass your message to *${agent.name}*.`
                : `*${agent.name}* isn't available through this bot.`,
          };
        }
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
    contextMessages: string[];
    historyAttachments: A2AAttachment[];
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
      return { contextMessages: [], historyAttachments: [] };
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

      // Only this bot's own turns are "You". Another bot's reply in the same
      // thread is shown as that bot's words, so one bot is never taught that it
      // said what a different bot said.
      const ownName =
        provider.getBotDisplayName?.() ?? archestraMcpBranding.appName;
      const contextMessages = history.map((msg) => {
        // A bot turn is replayed without the chrome the platform stamped onto
        // it — a footer left in here is a footer the model learns to write.
        const text = msg.isFromBot
          ? stripAgentFooterChrome(msg.text)
          : msg.text;
        const isSelf = msg.isFromSelf ?? msg.isFromBot;
        const sender = isSelf
          ? `You (${ownName})`
          : msg.isFromBot
            ? `${msg.senderName} (another bot)`
            : msg.senderName;
        // A file-only turn has no text; name its attachments so the turn is
        // meaningful (the file arrives separately or gets a skip note below).
        if (!text.trim() && msg.files?.length) {
          const names = msg.files
            .map((f) => (f.name ? `"${f.name}"` : "an unnamed file"))
            .join(", ");
          return `${sender}: [sent ${msg.files.length === 1 ? "an attachment" : "attachments"}: ${names}]`;
        }
        return `${sender}: ${text}`;
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
        const line = contextMessages[turnIndex];
        if (line !== undefined) {
          contextMessages[turnIndex] =
            line + buildHistorySkippedAttachmentsNote(skips);
        }
      }

      return { contextMessages, historyAttachments };
    } catch (error) {
      logger.error(
        { error: errorMessage(error) },
        "[ChatOps] Failed to fetch thread history",
      );
      return { contextMessages: [], historyAttachments: [] };
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
    announceAccessErrors: boolean;
  }): Promise<
    { success: true; userId: string } | { success: false; error: string }
  > {
    const {
      message,
      provider,
      agentId,
      agentName,
      organizationId,
      announceAccessErrors,
    } = params;
    const denyQuietly = !announceAccessErrors;

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
      if (!denyQuietly) {
        await this.sendSecurityErrorReply(
          provider,
          message,
          "Could not verify your identity. Please ensure the bot is properly installed in your team or chat.",
        );
      }
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

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const hasAccess = await ResourcePermissions.allows({
      userId: user.id,
      organizationId,
      resource: "agent",
      scope: agentId,
      action: "use",
    });
    // SPDX-SnippetEnd

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
      if (!denyQuietly) {
        await this.sendSecurityErrorReply(
          provider,
          message,
          `You don't have access to the agent "${agentName}". Contact your administrator for access.`,
        );
      }
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
   * Pin a Slack App's identity (workspace, bot user, app id) the first time it
   * authenticates, and refuse to run it afterwards when its token resolves to a
   * different identity. Without this a token pasted for another app would
   * silently inherit the first app's channels, agents and delayed output; a
   * token already held by another Slack App is refused by the unique identity
   * index. A refused app is stopped and stays stopped until its token is fixed.
   */
  private async pinSlackIdentity(bot: ChatOpsBot): Promise<void> {
    const provider = this.slackProviders.get(bot.id);
    const botUserId = provider?.getBotUserId();
    const workspaceId = provider?.getWorkspaceId();
    if (!provider || !botUserId || !workspaceId) return;

    const pinned = bot.externalBotUserId !== null;
    if (
      pinned &&
      (bot.externalBotUserId !== botUserId ||
        bot.externalWorkspaceId !== workspaceId)
    ) {
      await this.stopSlackProvider(bot.id);
      throw new Error(
        `Slack App "${bot.name}" now authenticates as a different bot (${botUserId} in ${workspaceId}) than the one it was set up with. Set up a new Slack App instead of reusing this one.`,
      );
    }
    if (pinned) return;

    try {
      await ChatOpsBotModel.update(bot.id, {
        externalBotUserId: botUserId,
        externalWorkspaceId: workspaceId,
        externalAppId: provider.getAppId(),
      });
    } catch (error) {
      await this.stopSlackProvider(bot.id);
      throw new Error(
        `Slack App "${bot.name}" uses a bot token that another Slack App already uses (${errorMessage(error)})`,
      );
    }
  }

  private async stopSlackProvider(botId: string): Promise<void> {
    const provider = this.slackProviders.get(botId);
    this.slackProviders.delete(botId);
    await provider?.cleanup();
  }

  /**
   * Seed chatops config from environment variables into the database.
   * Only runs on first startup — if DB already has config, this is a no-op.
   */
  private async seedConfigFromEnvVars(organizationId: string): Promise<void> {
    await this.seedMsTeamsConfigFromEnvVars();
    await this.seedSlackConfigFromEnvVars(organizationId);
    await this.seedTelegramConfigFromEnvVars();
  }

  /**
   * The org-level bot of a provider that only ever has one (Teams, Telegram),
   * created on first use so its bindings always have an owner.
   */
  private async ensureSingletonBot(params: {
    organizationId: string;
    provider: "ms-teams" | "telegram";
  }) {
    return await ChatOpsBotModel.ensureDefault({
      organizationId: params.organizationId,
      provider: params.provider,
      name: await OrganizationModel.getAppName(),
    });
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

  private async seedSlackConfigFromEnvVars(
    organizationId: string,
  ): Promise<void> {
    try {
      const existingBots = await ChatOpsBotModel.findByProvider({
        organizationId,
        provider: "slack",
      });
      if (existingBots.length > 0) return;
      // An admin removed a Slack App on purpose: its env credentials must not
      // bring it back on the next restart.
      if (await ChatOpsConfigModel.isSlackEnvSeedingDisabled()) return;

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

      const bot = await ChatOpsBotModel.create({
        organizationId,
        provider: "slack",
        name: await OrganizationModel.getAppName(),
      });
      await ChatOpsConfigModel.saveSlackConfig({
        bot,
        value: {
          enabled: process.env.ARCHESTRA_CHATOPS_SLACK_ENABLED === "true",
          botToken,
          signingSecret,
          appId: process.env.ARCHESTRA_CHATOPS_SLACK_APP_ID || "",
          connectionMode,
          appLevelToken,
        },
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
    binding: { id: string; organizationId: string; agentId: string | null };
    message: IncomingChatMessage;
    provider: ChatOpsProvider;
    fullMessage: string;
    ephemeralExecutionPrefix?: string;
    sendReply: boolean;
    userId: string;
  }): Promise<ChatOpsProcessingResult> {
    const {
      agent,
      binding,
      message,
      provider,
      fullMessage,
      ephemeralExecutionPrefix,
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

    // Platforms whose typing indicator expires on its own (Telegram: ~5s)
    // need a heartbeat, or long agent runs look stalled. Cleared in `finally`;
    // no explicit stop on reply is needed — the indicator drops when the
    // bot's message arrives.
    const typingHeartbeat =
      sendReply && provider.setTypingStatus && provider.typingRefreshIntervalMs
        ? setInterval(() => {
            provider
              .setTypingStatus?.(
                message.channelId,
                message.threadId ?? "",
                message.metadata,
              )
              .catch(() => {});
          }, provider.typingRefreshIntervalMs)
        : null;

    // Register this run so muting the thread can abort it mid-flight, and record
    // the thread's mute marker now: if it changes before we reply, the thread
    // was muted while we were working and the reply must be dropped (see
    // muteChannelThread / getThreadMuteMarker). The abort stops this pod's model
    // request; the marker is the cross-pod guarantee that no reply is posted
    // after a mute even when the run executed on a different pod than the mute.
    const threadKey = {
      provider: provider.providerId,
      botId: provider.botId,
      channelId: message.channelId,
      threadId: message.threadId ?? message.channelId,
    };
    // A sender's follow-up message supersedes their still-running turn: the
    // stale reply is dropped and only the follow-up gets answered — with the
    // earlier message in context. Only for server-side-session providers,
    // whose pre-execution persistence guarantees the superseded turn stays in
    // the thread history (stateless providers would lose it entirely).
    const supersede =
      provider.usesServerSideSessions === true
        ? {
            senderId: message.senderId,
            sequence:
              typeof message.metadata?.telegramMessageId === "number"
                ? message.metadata.telegramMessageId
                : message.timestamp.getTime(),
          }
        : undefined;
    const { signal: abortSignal, unregister } = chatOpsRunRegistry.register(
      threadKey,
      { supersede },
    );
    const muteMarkerAtStart = await getThreadMuteMarker(threadKey);

    try {
      const executeParams = {
        agent,
        binding,
        message,
        provider,
        fullMessage,
        ephemeralExecutionPrefix,
        userId,
        abortSignal,
        notifyContextCompaction: sendReply,
      };
      let execution: Awaited<ReturnType<ChatOpsManager["executeMessage"]>>;
      try {
        execution = await this.executeMessage(executeParams);
      } catch (error) {
        // The thread was muted mid-run: we aborted this run on purpose, so stay
        // silent rather than posting the abort as an error. The marker check
        // below also covers a run aborted on another pod (no local signal).
        if (abortSignal.aborted) {
          return await this.suppressMutedReply({
            provider,
            message,
            threadKey,
          });
        }
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

      // Drop the reply if the thread was muted while the run was in flight —
      // whether we aborted it here (abortSignal) or it ran to completion on
      // another pod (the marker moved). Muting means "be quiet now", so an
      // answer that lands after it would defeat the request.
      if (
        abortSignal.aborted ||
        (await this.threadMutedSinceStart(threadKey, muteMarkerAtStart))
      ) {
        return await this.suppressMutedReply({ provider, message, threadKey });
      }

      return await this.replyByMessageExecutionResult({
        agent: responseAgent,
        message,
        provider,
        sendReply,
        result,
      });
    } catch (error) {
      // A mute that aborted the run mid-flight (e.g. during the retry leg above)
      // surfaces here as a throw — stay silent rather than posting it as an
      // error, since the user just asked the bot to be quiet.
      if (abortSignal.aborted) {
        return await this.suppressMutedReply({ provider, message, threadKey });
      }

      logger.error(
        { messageId: message.messageId, error: errorMessage(error) },
        "[ChatOps] Failed to execute A2A message",
      );

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
    } finally {
      if (typingHeartbeat) clearInterval(typingHeartbeat);
      unregister();
    }
  }

  /**
   * Whether the thread was muted after this run started, by comparing the mute
   * marker captured at the start against the current one. A non-null current
   * marker that differs from the captured value means a mute landed mid-run; a
   * null current value (lapsed marker) is never treated as a mute, so it can't
   * cause a spurious suppression.
   */
  private async threadMutedSinceStart(
    threadKey: {
      provider: ChatOpsProviderType;
      botId: string;
      channelId: string;
      threadId: string;
    },
    muteMarkerAtStart: string | null,
  ): Promise<boolean> {
    const current = await getThreadMuteMarker(threadKey);
    return current !== null && current !== muteMarkerAtStart;
  }

  /**
   * Silently drop the reply for a run aborted mid-flight — the thread was
   * muted, or the run was superseded by the sender's follow-up message: clear
   * the lingering "typing…" indicator and report success with no response
   * (same shape as the agent deliberately staying quiet), so nothing is
   * posted.
   */
  private async suppressMutedReply(params: {
    provider: ChatOpsProvider;
    message: IncomingChatMessage;
    threadKey: {
      provider: ChatOpsProviderType;
      botId: string;
      channelId: string;
      threadId: string;
    };
  }): Promise<ChatOpsProcessingResult> {
    const { provider, message, threadKey } = params;
    logger.info(
      {
        messageId: message.messageId,
        provider: threadKey.provider,
        botId: threadKey.botId,
        channelId: threadKey.channelId,
        threadId: threadKey.threadId,
      },
      "[ChatOps] Run aborted (thread muted or superseded by a follow-up) — dropping reply",
    );
    await provider
      .clearTypingStatus?.(message.channelId, message.threadId ?? "")
      ?.catch(() => {});
    return { success: true, agentResponse: "" };
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
    const isSubagentError = error instanceof SubagentProviderError;
    const sourcedErrorDetail = isSubagentError
      ? `Subagent ${error.subagentName} · ${errorDetail}`
      : errorDetail;

    // The LLM provider rejected the API key (e.g. Anthropic's "invalid
    // x-api-key"). Users rarely realize the bot resolves its model/key the
    // same way in-app chat does, so name the key that was used and where to
    // fix it instead of leaving only the provider's cryptic one-liner.
    if (isLlmProviderAuthError(errMsg)) {
      const usedLlm = llmContext
        ? await this.describeLlmUsedForRun({
            ...llmContext,
            agentId: isSubagentError ? error.subagentId : llmContext.agentId,
          })
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
        footer: footer(sourcedErrorDetail),
        conversationReference: message.metadata?.conversationReference,
      });
      return;
    }

    await provider.sendReply({
      originalMessage: message,
      text: isSubagentError
        ? "Sorry, a subagent encountered an error while processing your request."
        : "Sorry, I encountered an error processing your request.",
      footer: footer(sourcedErrorDetail),
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
      // The label reads the key's owner and grants, not the retired column.
      const keyScope = key
        ? ((
            await LlmProviderApiKeyModel.findDisplayScopes({
              organizationId: params.organizationId,
              keys: [key],
            })
          ).get(key.id) ?? "personal")
        : null;
      const keyDescription =
        key && keyScope
          ? `the ${LLM_KEY_SCOPE_LABELS[keyScope]} ${providerLabel} API key "${key.name}"`
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

  private async replyByMessageExecutionResult(params: {
    agent: { id: string; name: string };
    message: IncomingChatMessage;
    provider: ChatOpsProvider;
    sendReply: boolean;
    currentApprovalId?: string; // if replying from an approval flow
    result: A2AProtocolSendMessageResponse;
  }): Promise<ChatOpsProcessingResult> {
    const { agent, message, provider, sendReply, currentApprovalId, result } =
      params;

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
    let agentResponse = compactChatOpsResponse(stripThinkingBlocks(text));

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
        footer: buildAgentFooter(agent.name),
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
      botId: provider.botId,
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
        const { toolName, toolInput } = resolveRunToolTarget({
          toolName: approvalRequest.toolName,
          args: approvalRequest.toolInput,
        });
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
    /** Per-turn framing executed with the message but not persisted (server-side sessions). */
    ephemeralExecutionPrefix?: string;
    userId: string;
    /** Aborts the agent run when the thread is muted mid-flight. */
    abortSignal?: AbortSignal;
    /** Post a chat notice when loading history triggers a compaction. */
    notifyContextCompaction?: boolean;
  }): Promise<{
    result: A2AProtocolSendMessageResponse;
    responseAgent: { id: string; name: string };
  }> {
    const {
      agent,
      binding,
      message,
      provider,
      fullMessage,
      ephemeralExecutionPrefix,
      userId,
      abortSignal,
      notifyContextCompaction,
    } = params;

    // Use thread ID (or channel ID for non-threaded messages) as session ID
    // so all messages in the same thread are grouped together in logs
    const sessionId = buildChatOpsSessionId({
      providerId: provider.providerId,
      botId: provider.botId,
      channelId: message.channelId,
      threadId: message.threadId,
    });
    const effectiveThreadId =
      message.threadId ?? message.channelId ?? message.messageId;

    const actor = {
      kind: "user" as const,
      id: userId,
      organizationId: binding.organizationId,
    };

    // Server-side sessions: every thread runs against its persistent A2A
    // context, which carries the conversation history Telegram's API can't
    // provide.
    const contextId =
      provider.usesServerSideSessions === true
        ? await this.resolveThreadContextId({
            provider,
            message,
            threadId: effectiveThreadId,
            actor,
          })
        : undefined;

    const request = buildSendMessageRequest({
      contextId,
      parts: [
        { text: fullMessage },
        ...buildAttachmentsMessageParts(message.attachments || []),
      ],
    });
    const source: InteractionSource =
      CHATOPS_PROVIDER_SOURCES[provider.providerId];
    const systemParams: A2ASystemParams = {
      sessionId,
      source,
      routeCategory: RouteCategory.CHATOPS,
      completionTarget: {
        type: "chatops",
        bindingId: binding.id,
        threadId: effectiveThreadId,
      },
      ephemeralExecutionPrefix,
    };

    const a2aManager = contextId ? this.statefulA2aManager : this.a2aManager;
    const initialResult = await a2aManager.sendMessage({
      actor,
      agentId: agent.id,
      request,
      systemParams,
      abortSignal,
      // Tell the user their conversation was summarized — otherwise the model
      // suddenly "forgetting" details reads as a bug.
      onContextCompacted: notifyContextCompaction
        ? async () => {
            await provider
              .sendReply({
                originalMessage: message,
                text: CHATOPS_CONTEXT_COMPACTED_NOTICE,
              })
              .catch((error) => {
                logger.warn(
                  { error: errorMessage(error), messageId: message.messageId },
                  "[ChatOps] Failed to post context-compaction notice",
                );
              });
          }
        : undefined,
    });

    return { result: initialResult, responseAgent: agent };
  }

  /**
   * Resolve (or create) the persistent A2A context backing a chat thread.
   * The mapping is keyed like the LLM session id — thread id, falling back
   * to channel id — so a Telegram DM or plain group is one long conversation.
   */
  private async resolveThreadContextId(params: {
    provider: ChatOpsProvider;
    message: IncomingChatMessage;
    threadId: string;
    actor: { kind: "user"; id: string; organizationId: string };
  }): Promise<string> {
    const threadKey = {
      provider: params.provider.providerId,
      channelId: params.message.channelId,
      workspaceId: params.message.workspaceId ?? null,
      threadId: params.threadId,
    };
    const existing = await ChatOpsThreadContextModel.findByThread(threadKey);
    if (existing) {
      return existing.contextId;
    }

    // The context's recorded owner is whoever spoke first; later access goes
    // through the trusted-access manager, which authorizes via this manager's
    // own checks rather than context ownership.
    const context = await A2AContextManager.createContext(params.actor);
    const mapping = await ChatOpsThreadContextModel.createOrGet({
      ...threadKey,
      contextId: context.id,
    });
    return mapping.contextId;
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
        botId: provider.botId,
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

      // Server-side-session providers resume through the stateful manager:
      // the approval task lives under the shared thread context, whose
      // recorded owner may be another participant (trusted access), and the
      // resumed run must see the thread's history.
      const approvalA2aManager =
        provider.usesServerSideSessions === true
          ? this.statefulA2aManager
          : this.a2aManager;
      const result = await approvalA2aManager.sendMessage({
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
          sessionId: buildChatOpsSessionId({
            providerId: provider.providerId,
            botId: provider.botId,
            channelId: decision.channelId,
            threadId: originalMessage.threadId,
          }),
          source: CHATOPS_PROVIDER_SOURCES[provider.providerId],
          // Resuming after an approval is still a ChatOps run; without this it
          // would fall back to the A2A route category like the initial send did.
          routeCategory: RouteCategory.CHATOPS,
        },
      });

      await this.replyByMessageExecutionResult({
        agent,
        message: originalMessage,
        provider,
        sendReply: true,
        currentApprovalId: decision.approvalId,
        result,
      });
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
 * Prefixed with provider to avoid collisions across providers, and with a short
 * bot id so two bots answering in one thread are grouped separately. Slack
 * thread timestamps are channel-scoped, so include the channel for Slack threads.
 *
 * MS Teams DM channel IDs can be 100+ chars. Long session IDs overflow the
 * 128-char Prometheus exemplar label budget, so we hash identifiers that
 * would push the total past a safe length.
 * @public — exported for testability
 */
export function buildChatOpsSessionId(params: {
  providerId: string;
  /** Keeps two bots in one thread in separate log sessions. */
  botId: string;
  channelId: string;
  threadId?: string;
}): string {
  const { providerId, botId, channelId, threadId } = params;
  const id =
    providerId === "slack" && threadId !== undefined
      ? `${channelId}:${threadId}`
      : (threadId ?? channelId);
  const prefix = `chatops:${providerId}:${botId.slice(0, 8)}:`;
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
