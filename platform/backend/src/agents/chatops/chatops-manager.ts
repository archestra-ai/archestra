import { executeA2AMessage } from "@/agents/a2a-executor";
import { userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ChatOpsChannelBindingModel,
  ChatOpsProcessedMessageModel,
  OrganizationModel,
  UserModel,
} from "@/models";
import {
  type ChatOpsProcessingResult,
  type ChatOpsProvider,
  type ChatOpsProviderType,
  ChatOpsProviderTypeSchema,
  type IncomingChatMessage,
} from "@/types/chatops";
import { CHATOPS_MESSAGE_RETENTION } from "./constants";
import MSTeamsProvider from "./ms-teams-provider";

/**
 * ChatOps Manager - handles chatops provider lifecycle and message processing
 */
export class ChatOpsManager {
  private msTeamsProvider: MSTeamsProvider | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  getMSTeamsProvider(): MSTeamsProvider | null {
    if (!this.msTeamsProvider) {
      this.msTeamsProvider = new MSTeamsProvider();
      if (!this.msTeamsProvider.isConfigured()) {
        return null;
      }
    }
    return this.msTeamsProvider;
  }

  getChatOpsProvider(
    providerType: ChatOpsProviderType,
  ): ChatOpsProvider | null {
    switch (providerType) {
      case "ms-teams":
        return this.getMSTeamsProvider();
    }
  }

  /**
   * Get agents available for a chatops provider, filtered by user access.
   * If senderEmail is provided and resolves to a user, only returns agents
   * the user has team-based access to. Falls back to all agents if user
   * cannot be resolved (access check still happens at message processing time).
   */
  async getAccessibleChatopsAgents(params: {
    provider: ChatOpsProviderType;
    senderEmail?: string;
  }): Promise<{ id: string; name: string }[]> {
    const agents = await AgentModel.findByAllowedChatopsProvider(
      params.provider,
    );

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

    const isProfileAdmin = await userHasPermission(
      user.id,
      org.id,
      "profile",
      "admin",
    );
    const accessibleIds = await AgentTeamModel.getUserAccessibleAgentIds(
      user.id,
      isProfileAdmin,
    );
    const accessibleSet = new Set(accessibleIds);
    return agents.filter((a) => accessibleSet.has(a.id));
  }

  /**
   * Check if any chatops provider is configured and enabled.
   */
  isAnyProviderConfigured(): boolean {
    return ChatOpsProviderTypeSchema.options.some((type) =>
      this.getChatOpsProvider(type)?.isConfigured(),
    );
  }

  async initialize(): Promise<void> {
    if (!this.isAnyProviderConfigured()) {
      return;
    }

    const providers: { name: string; provider: ChatOpsProvider | null }[] = [
      { name: "MS Teams", provider: this.getMSTeamsProvider() },
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

    this.startProcessedMessageCleanup();
  }

  async cleanup(): Promise<void> {
    if (this.msTeamsProvider) {
      await this.msTeamsProvider.cleanup();
      this.msTeamsProvider = null;
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

    // Check if the agent allows this chatops provider
    if (!agent.allowedChatops?.includes(provider.providerId)) {
      logger.warn(
        {
          agentId: binding.agentId,
          provider: provider.providerId,
          allowedChatops: agent.allowedChatops,
        },
        "[ChatOps] Agent does not allow this chatops provider",
      );
      return { success: false, error: "PROVIDER_NOT_ALLOWED" };
    }

    // Resolve inline agent mention
    const {
      agentToUse,
      cleanedMessageText: _cleanedMessageText,
      fallbackMessage,
    } = await this.resolveInlineAgentMention({
      messageText: message.text,
      defaultAgent: agent,
      provider,
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

    // Build the full message with context
    let fullMessage = message.text;
    if (contextMessages.length > 0) {
      fullMessage = `Previous conversation:\n${contextMessages.join("\n")}\n\nUser: ${message.text}`;
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
    provider: ChatOpsProvider;
  }): Promise<{
    agentToUse: { id: string; name: string };
    cleanedMessageText: string;
    fallbackMessage?: string;
  }> {
    const { messageText, defaultAgent, provider } = params;

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

    const availableAgents = await AgentModel.findByAllowedChatopsProvider(
      provider.providerId,
    );

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
    const isProfileAdmin = await userHasPermission(
      user.id,
      organizationId,
      "profile",
      "admin",
    );
    const hasAccess = await AgentTeamModel.userHasAgentAccess(
      user.id,
      agentId,
      isProfileAdmin,
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
      const result = await executeA2AMessage({
        agentId: agent.id,
        organizationId: binding.organizationId,
        message: fullMessage,
        userId,
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  // Handle objects that may not convert to string properly
  try {
    return String(error);
  } catch {
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error (could not serialize)";
    }
  }
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
