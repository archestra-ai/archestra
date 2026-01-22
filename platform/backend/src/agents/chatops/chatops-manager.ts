import { executeA2AMessage } from "@/agents/a2a-executor";
import logger from "@/logging";
import {
  AgentModel,
  ChatOpsChannelBindingModel,
  ChatOpsProcessedMessageModel,
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
   * Pattern: ">AgentName message" switches to a different agent.
   * Tolerant matching handles variations like ">AgentPeter", "> Agent Peter".
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

    if (!messageText.startsWith(">")) {
      return { agentToUse: defaultAgent, cleanedMessageText: messageText };
    }

    const textAfterPrefix = messageText.slice(1).trimStart();
    const availableAgents = await AgentModel.findByAllowedChatopsProvider(
      provider.providerId,
    );

    // Sort by name length (longest first) to match "Agent Peter" before "Agent"
    const sortedAgents = [...availableAgents].sort(
      (a, b) => b.name.length - a.name.length,
    );

    for (const agent of sortedAgents) {
      const matchLength = findTolerantMatchLength(textAfterPrefix, agent.name);
      if (matchLength !== null) {
        return {
          agentToUse: agent,
          cleanedMessageText: textAfterPrefix.slice(matchLength).trim(),
        };
      }
    }

    // No known agent matched - extract potential name for fallback message
    const potentialName = textAfterPrefix.split(/\s{2,}|\n/)[0].trim();
    if (potentialName) {
      return {
        agentToUse: defaultAgent,
        cleanedMessageText:
          textAfterPrefix.slice(potentialName.length).trim() || textAfterPrefix,
        fallbackMessage: `${potentialName} not found, using ${defaultAgent.name}`,
      };
    }

    return { agentToUse: defaultAgent, cleanedMessageText: messageText };
  }

  private async fetchThreadHistory(
    message: IncomingChatMessage,
    provider: ChatOpsProvider,
  ): Promise<string[]> {
    if (!message.threadId) {
      return [];
    }

    try {
      const history = await provider.getThreadHistory({
        channelId: message.channelId,
        workspaceId: message.workspaceId,
        threadId: message.threadId,
        excludeMessageId: message.messageId,
      });

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

  private async executeAndReply(params: {
    agent: { id: string; name: string };
    binding: { organizationId: string };
    message: IncomingChatMessage;
    provider: ChatOpsProvider;
    fullMessage: string;
    sendReply: boolean;
    fallbackMessage?: string;
  }): Promise<ChatOpsProcessingResult> {
    const { agent, binding, message, provider, fullMessage, sendReply } =
      params;

    try {
      const result = await executeA2AMessage({
        agentId: agent.id,
        organizationId: binding.organizationId,
        message: fullMessage,
        userId: `chatops-${provider.providerId}-${message.senderId}`,
      });

      const agentResponse = result.text || "";

      if (sendReply && agentResponse) {
        await provider.sendReply({
          originalMessage: message,
          text: agentResponse,
          footer: `Routed to ${agent.name}. Use @Archestra /select-agent to change.`,
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
  return error instanceof Error ? error.message : String(error);
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
 * Find tolerant match length for an agent name at the start of text.
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
