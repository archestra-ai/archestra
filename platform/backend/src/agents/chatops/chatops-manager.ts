import { executeA2AMessage } from "@/agents/a2a-executor";
import { userHasPermission } from "@/auth/utils";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ChatOpsChannelBindingModel,
  ChatOpsConfigModel,
  ChatOpsProcessedMessageModel,
  OrganizationModel,
  UserModel,
} from "@/models";
import {
  RouteCategory,
  startActiveChatSpan,
} from "@/routes/proxy/utils/tracing";
import type {
  ChatOpsProcessingResult,
  ChatOpsProvider,
  ChatOpsProviderType,
  IncomingChatMessage,
} from "@/types/chatops";
import {
  CHATOPS_CHANNEL_DISCOVERY,
  CHATOPS_MESSAGE_RETENTION,
  SLACK_SLASH_COMMANDS,
} from "./constants";
import MSTeamsProvider from "./ms-teams-provider";
import SlackProvider, { type SlackInteractivePayload } from "./slack-provider";
import { errorMessage } from "./utils";

/**
 * ChatOps Manager - handles chatops provider lifecycle and message processing
 */
export class ChatOpsManager {
  private msTeamsProvider: MSTeamsProvider | null = null;
  private slackProvider: SlackProvider | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  getMSTeamsProvider(): MSTeamsProvider | null {
    return this.msTeamsProvider;
  }

  getSlackProvider(): SlackProvider | null {
    return this.slackProvider;
  }

  getChatOpsProvider(
    providerType: ChatOpsProviderType,
  ): ChatOpsProvider | null {
    switch (providerType) {
      case "ms-teams":
        return this.getMSTeamsProvider();
      case "slack":
        return this.getSlackProvider();
    }
  }

  /**
   * Get agents available for a chatops provider, filtered by user access.
   * If senderEmail is provided and resolves to a user, only returns agents
   * the user has team-based access to. Falls back to all agents if user
   * cannot be resolved (access check still happens at message processing time).
   */
  async getAccessibleChatopsAgents(params: {
    senderEmail?: string;
  }): Promise<{ id: string; name: string }[]> {
    const agents = await AgentModel.findAllInternalAgents();

    if (!params.senderEmail || agents.length === 0) {
      return agents;
    }

    const user = await UserModel.findByEmail(params.senderEmail.toLowerCase());
    if (!user) {
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
      (this.slackProvider?.isConfigured() ?? false)
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
    const [msTeamsConfig, slackConfig] = await Promise.all([
      ChatOpsConfigModel.getMsTeamsConfig(),
      ChatOpsConfigModel.getSlackConfig(),
    ]);

    // Create providers with their config
    if (msTeamsConfig) {
      this.msTeamsProvider = new MSTeamsProvider(msTeamsConfig);
    }
    if (slackConfig) {
      this.slackProvider = new SlackProvider(slackConfig);
    }

    if (!this.isAnyProviderConfigured()) {
      return;
    }

    const providers: { name: string; provider: ChatOpsProvider | null }[] = [
      { name: "MS Teams", provider: this.msTeamsProvider },
      { name: "Slack", provider: this.slackProvider },
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

    // Wire socket mode events for Slack if in socket mode
    if (this.slackProvider?.isSocketMode()) {
      this.slackProvider.setSocketEventHandler((type, payload) => {
        this.processSlackSocketEvent(type, payload).catch((error) => {
          logger.error(
            { error: errorMessage(error), eventType: type },
            "[ChatOps] Error processing Slack socket event",
          );
        });
      });
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
    this.stopCleanupInterval();
  }

  stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Handle a Slack message event (extracted from webhook route for reuse by socket mode).
   * Covers: dedup, channel discovery, email resolution, user verification,
   * binding check, agent selection or processMessage().
   */
  async handleSlackMessage(
    provider: SlackProvider,
    body: unknown,
  ): Promise<void> {
    const headers: Record<string, string | string[] | undefined> = {};
    const message = await provider.parseWebhookNotification(body, headers);
    if (!message) return;

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
      logger.warn("[ChatOps] Could not resolve Slack user email");
      await provider.sendReply({
        originalMessage: message,
        text: "Could not verify your identity. Please ensure your Slack profile has an email configured.",
      });
      return;
    }

    const user = await UserModel.findByEmail(message.senderEmail.toLowerCase());
    if (!user) {
      await provider.sendReply({
        originalMessage: message,
        text: `You (${message.senderEmail}) are not a registered Archestra user. Contact your administrator for access.`,
      });
      return;
    }

    // Check for existing binding
    const binding = await ChatOpsChannelBindingModel.findByChannel({
      provider: "slack",
      channelId: message.channelId,
      workspaceId: message.workspaceId,
    });

    if (!binding || !binding.agentId) {
      // Create binding early (without agent) so the DM/channel appears in the UI
      if (!binding) {
        const isSlackDm = message.metadata?.channelType === "im";
        const organizationId = await getDefaultOrganizationId();
        await ChatOpsChannelBindingModel.upsertByChannel({
          organizationId,
          provider: "slack",
          channelId: message.channelId,
          workspaceId: message.workspaceId,
          workspaceName: provider.getWorkspaceName() ?? undefined,
          channelName: isSlackDm
            ? `Direct Message - ${message.senderEmail}`
            : undefined,
          isDm: isSlackDm,
          dmOwnerEmail: isSlackDm ? message.senderEmail : undefined,
        });
      }

      // Show agent selection
      await this.sendSlackAgentSelectionCard(provider, message, true);
      return;
    }

    // Process message through bound agent
    await this.processMessage({
      message,
      provider,
      sendReply: true,
    });
  }

  /**
   * Handle a Slack interactive payload (extracted from webhook route for reuse by socket mode).
   * Covers: parse selection, verify user, verify agent, upsert binding, confirm.
   */
  async handleSlackInteractive(
    provider: SlackProvider,
    payload: SlackInteractivePayload,
  ): Promise<void> {
    const selection = provider.parseInteractivePayload(payload);
    if (!selection) return;

    // Verify the user clicking the button is a registered Archestra user
    const senderEmail = await provider.getUserEmail(selection.userId);
    if (!senderEmail) {
      logger.warn("[ChatOps] Could not resolve Slack interactive user email");
      return;
    }
    const user = await UserModel.findByEmail(senderEmail.toLowerCase());
    if (!user) {
      logger.warn(
        { senderEmail },
        "[ChatOps] Slack interactive user not registered in Archestra",
      );
      return;
    }

    // Verify agent exists
    const agent = await AgentModel.findById(selection.agentId);
    if (!agent) return;

    const organizationId = await getDefaultOrganizationId();

    // Create or update binding
    const isSlackDm = selection.channelId.startsWith("D");
    await ChatOpsChannelBindingModel.upsertByChannel({
      organizationId,
      provider: "slack",
      channelId: selection.channelId,
      workspaceId: selection.workspaceId,
      workspaceName: provider.getWorkspaceName() ?? undefined,
      channelName: isSlackDm ? `Direct Message - ${senderEmail}` : undefined,
      isDm: isSlackDm,
      dmOwnerEmail: isSlackDm ? senderEmail : undefined,
      agentId: selection.agentId,
    });

    // Confirm the selection in the thread
    const message: IncomingChatMessage = {
      messageId: `slack-selection-${Date.now()}`,
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
      text: `Agent *${agent.name}* is now bound to this ${isSlackDm ? "conversation" : "channel"}.\nSend a message to start interacting!`,
    });
  }

  /**
   * Handle a Slack slash command (extracted from webhook route for reuse by socket mode).
   * Returns the response text/object. Caller is responsible for delivery
   * (HTTP response for webhooks, response_url POST for socket mode).
   */
  async handleSlackSlashCommand(
    provider: SlackProvider,
    body: {
      command?: string;
      text?: string;
      user_id?: string;
      user_name?: string;
      channel_id?: string;
      channel_name?: string;
      team_id?: string;
      response_url?: string;
      trigger_id?: string;
    },
  ): Promise<{ response_type: string; text: string } | null> {
    const command = body.command;
    const channelId = body.channel_id || "";
    const workspaceId = body.team_id || null;
    const userId = body.user_id || "unknown";

    // Resolve sender email and verify user
    const senderEmail = await provider.getUserEmail(userId);
    if (!senderEmail) {
      return {
        response_type: "ephemeral",
        text: "Could not verify your identity. Please ensure your Slack profile has an email configured.",
      };
    }

    const user = await UserModel.findByEmail(senderEmail.toLowerCase());
    if (!user) {
      return {
        response_type: "ephemeral",
        text: `You (${senderEmail}) are not a registered Archestra user. Contact your administrator for access.`,
      };
    }

    // Build an IncomingChatMessage for reuse with existing helpers
    const message: IncomingChatMessage = {
      messageId: `slack-slash-${Date.now()}`,
      channelId,
      workspaceId,
      threadId: undefined,
      senderId: userId,
      senderName: body.user_name || "Unknown User",
      senderEmail,
      text: body.text || "",
      rawText: body.text || "",
      timestamp: new Date(),
      isThreadReply: false,
    };

    switch (command) {
      case SLACK_SLASH_COMMANDS.HELP:
        return {
          response_type: "ephemeral",
          text:
            "*Available commands:*\n" +
            "`/archestra-select-agent` — Change the default agent\n" +
            "`/archestra-status` — Show current agent binding\n" +
            "`/archestra-help` — Show this help message\n\n" +
            "Or just send a message to interact with the bound agent.",
        };

      case SLACK_SLASH_COMMANDS.STATUS: {
        const binding = await ChatOpsChannelBindingModel.findByChannel({
          provider: "slack",
          channelId,
          workspaceId,
        });

        if (binding?.agentId) {
          const agent = await AgentModel.findById(binding.agentId);
          return {
            response_type: "ephemeral",
            text:
              `This channel is bound to agent: *${agent?.name || binding.agentId}*\n\n` +
              "*Tip:* You can use other agents with the syntax *AgentName >* (e.g., @Archestra Sales > what's the status?).\n\n" +
              "Use `/archestra-select-agent` to change the default agent.",
          };
        }

        return {
          response_type: "ephemeral",
          text: "No agent is bound to this channel yet.\nSend any message to set up an agent binding.",
        };
      }

      case SLACK_SLASH_COMMANDS.SELECT_AGENT: {
        // Send agent selection card (visible to all in channel)
        await this.sendSlackAgentSelectionCard(provider, message, false);
        return { response_type: "in_channel", text: "" };
      }

      default:
        return {
          response_type: "ephemeral",
          text: "Unknown command. Use `/archestra-help` to see available commands.",
        };
    }
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

    // Check if the binding has an agent assigned
    if (!binding.agentId) {
      logger.warn(
        { bindingId: binding.id },
        "[ChatOps] Binding has no agent assigned",
      );
      return { success: false, error: "NO_AGENT_ASSIGNED" };
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
    const { agentToUse, cleanedMessageText, fallbackMessage } =
      await this.resolveInlineAgentMention({
        messageText: message.text,
        defaultAgent: agent,
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

    // Build context from thread history
    const contextMessages = await this.fetchThreadHistory(message, provider);

    // Build the full message with context — use cleanedMessageText so
    // the "AgentName >" prefix is stripped from what the LLM sees
    let fullMessage = cleanedMessageText;
    if (contextMessages.length > 0) {
      fullMessage = `Previous conversation:\n${contextMessages.join("\n")}\n\nUser: ${cleanedMessageText}`;
    }

    // Execute the A2A message using the agent
    return this.executeAndReply({
      agent: agentToUse,
      binding,
      message,
      provider,
      fullMessage,
      sendReply,
      fallbackMessage,
      userId: authResult.userId,
    });
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async sendSlackAgentSelectionCard(
    provider: SlackProvider,
    message: IncomingChatMessage,
    isWelcome: boolean,
  ): Promise<void> {
    const agents = await this.getAccessibleChatopsAgents({
      senderEmail: message.senderEmail,
    });

    if (agents.length === 0) {
      await provider.sendReply({
        originalMessage: message,
        text: "No agents are available for you in Slack.\nContact your administrator to get access to an agent with Slack enabled.",
      });
      return;
    }

    await provider.sendAgentSelectionCard({
      message,
      agents,
      isWelcome,
    });
  }

  private async processSlackSocketEvent(
    type: "event" | "interactive" | "slash_command",
    payload: unknown,
  ): Promise<void> {
    const provider = this.slackProvider;
    if (!provider) {
      logger.warn("[ChatOps] Socket event received but Slack provider is null");
      return;
    }

    switch (type) {
      case "event":
        await this.handleSlackMessage(provider, payload);
        break;
      case "interactive":
        await this.handleSlackInteractive(
          provider,
          payload as SlackInteractivePayload,
        );
        break;
      case "slash_command": {
        const body = payload as {
          command?: string;
          text?: string;
          user_id?: string;
          user_name?: string;
          channel_id?: string;
          channel_name?: string;
          team_id?: string;
          response_url?: string;
          trigger_id?: string;
        };
        const response = await this.handleSlackSlashCommand(provider, body);
        // In socket mode, slash commands are already ack'd. Send response via response_url.
        if (response && body.response_url) {
          try {
            await fetch(body.response_url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(response),
            });
          } catch (error) {
            logger.error(
              { error: errorMessage(error) },
              "[ChatOps] Failed to send slash command response via response_url",
            );
          }
        }
        break;
      }
    }
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
    fallbackMessage?: string;
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

    // No known agent matched - return fallback with the message after delimiter
    return {
      agentToUse: defaultAgent,
      cleanedMessageText: messageAfterDelimiter || messageText,
      fallbackMessage: `"${potentialAgentName}" not found, using ${defaultAgent.name}`,
    };
  }

  private async fetchThreadHistory(
    message: IncomingChatMessage,
    provider: ChatOpsProvider,
  ): Promise<string[]> {
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

    if (!message.threadId) {
      logger.debug("[ChatOps] No threadId, skipping thread history fetch");
      return [];
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

      return history.map((msg) => {
        const text = msg.isFromBot ? stripBotFooter(msg.text) : msg.text;
        const sender = msg.isFromBot ? "Assistant" : msg.senderName;
        return `${sender}: ${text}`;
      });
    } catch (error) {
      logger.error(
        { error: errorMessage(error) },
        "[ChatOps] Failed to fetch thread history",
      );
      return [];
    }
  }

  /**
   * Validate that the MS Teams user has access to the agent.
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

    // Look up Archestra user by email
    const user = await UserModel.findByEmail(userEmail.toLowerCase());

    if (!user) {
      logger.warn(
        { senderEmail: userEmail },
        "[ChatOps] User not registered in Archestra",
      );
      await this.sendSecurityErrorReply(
        provider,
        message,
        `You (${userEmail}) are not a registered Archestra user. Contact your administrator for access.`,
      );
      return {
        success: false,
        error: `Unauthorized: ${userEmail} is not a registered Archestra user`,
      };
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
        footer: "Security check failed",
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
        (process.env.ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE as
          | "webhook"
          | "socket"
          | undefined) || "webhook";
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

  private async executeAndReply(params: {
    agent: { id: string; name: string };
    binding: { organizationId: string };
    message: IncomingChatMessage;
    provider: ChatOpsProvider;
    fullMessage: string;
    sendReply: boolean;
    fallbackMessage?: string;
    userId: string;
  }): Promise<ChatOpsProcessingResult> {
    const {
      agent,
      binding,
      message,
      provider,
      fullMessage,
      sendReply,
      userId,
    } = params;

    try {
      // Resolve user for span attributes
      const chatOpsUser =
        userId !== "system" ? await UserModel.getById(userId) : null;

      // Wrap A2A execution with a parent span so all LLM and MCP tool calls
      // appear as children of a single unified trace. The provider ID (e.g.
      // "ms-teams", "slack") is recorded as archestra.trigger.source so traces
      // can be filtered by invocation channel.
      const result = await startActiveChatSpan({
        agentName: agent.name,
        agentId: agent.id,
        routeCategory: RouteCategory.CHATOPS,
        triggerSource: provider.providerId,
        user: chatOpsUser
          ? {
              id: chatOpsUser.id,
              email: chatOpsUser.email,
              name: chatOpsUser.name,
            }
          : null,
        callback: async () => {
          return executeA2AMessage({
            agentId: agent.id,
            organizationId: binding.organizationId,
            message: fullMessage,
            userId,
          });
        },
      });

      const agentResponse = result.text || "";

      if (sendReply && agentResponse) {
        await provider.sendReply({
          originalMessage: message,
          text: agentResponse,
          footer: `Via ${agent.name}`,
          conversationReference: message.metadata?.conversationReference,
        });
      }

      return {
        success: true,
        agentResponse,
        interactionId: result.messageId,
      };
    } catch (error) {
      logger.error(
        { messageId: message.messageId, error: errorMessage(error) },
        "[ChatOps] Failed to execute A2A message",
      );

      if (sendReply) {
        await provider.sendReply({
          originalMessage: message,
          text: "Sorry, I encountered an error processing your request.",
          conversationReference: message.metadata?.conversationReference,
        });
      }

      return { success: false, error: errorMessage(error) };
    }
  }
}

export const chatOpsManager = new ChatOpsManager();

// =============================================================================
// Internal Helpers
// =============================================================================

async function getDefaultOrganizationId(): Promise<string> {
  const org = await OrganizationModel.getFirst();
  if (!org) {
    throw new Error("No organizations found");
  }
  return org.id;
}

/**
 * Strip bot footer from message text to avoid LLM repeating it.
 * Handles markdown, HTML, and plain text footer formats.
 */
function stripBotFooter(text: string): string {
  return text
    .replace(/\n\n---\n_(?:Via .+?|.+? not found, using .+?)_$/i, "")
    .replace(
      /<hr\s*\/?>\s*<em>(?:Via .+?|.+? not found, using .+?)<\/em>$/i,
      "",
    )
    .replace(/\s*(?:Via .+?|.+? not found, using .+?)$/i, "")
    .trim();
}

/**
 * Check if a given input string matches an agent name.
 * Tolerant matching: case-insensitive, ignores spaces.
 * E.g., "AgentPeter", "agent peter", "agentpeter" all match "Agent Peter".
 *
 * @internal Exported for testing
 */
export function matchesAgentName(input: string, agentName: string): boolean {
  const normalizedInput = input.toLowerCase().replace(/\s+/g, "");
  const normalizedName = agentName.toLowerCase().replace(/\s+/g, "");
  return normalizedInput === normalizedName;
}

/**
 * Find length of agent name match at start of text.
 * Handles "AgentPeter", "Agent Peter", "agent peter" for "Agent Peter".
 * Returns matched length or null if no match.
 *
 * @internal Exported for testing
 */
export function findTolerantMatchLength(
  text: string,
  agentName: string,
): number | null {
  const lowerText = text.toLowerCase();
  const lowerName = agentName.toLowerCase();

  // Strategy 1: Exact match (with spaces)
  if (lowerText.startsWith(lowerName)) {
    const charAfter = text[agentName.length];
    if (!charAfter || charAfter === " " || charAfter === "\n") {
      return agentName.length;
    }
  }

  // Strategy 2: Match without spaces (e.g., "agentpeter" matches "Agent Peter")
  const nameWithoutSpaces = lowerName.replace(/\s+/g, "");
  let textIdx = 0;
  let nameIdx = 0;

  while (nameIdx < nameWithoutSpaces.length && textIdx < text.length) {
    const textChar = lowerText[textIdx];
    const nameChar = nameWithoutSpaces[nameIdx];

    if (textChar === nameChar) {
      textIdx++;
      nameIdx++;
    } else if (textChar === " ") {
      textIdx++;
    } else {
      return null;
    }
  }

  if (nameIdx === nameWithoutSpaces.length) {
    const charAfter = text[textIdx];
    if (!charAfter || charAfter === " " || charAfter === "\n") {
      return textIdx;
    }
  }

  return null;
}
