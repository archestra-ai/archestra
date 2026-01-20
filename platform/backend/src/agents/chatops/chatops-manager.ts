import { executeA2AMessage } from "@/agents/a2a-executor";
import logger from "@/logging";
import {
  ChatOpsChannelBindingModel,
  ChatOpsProcessedMessageModel,
  PromptModel,
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

  /**
   * Get the MS Teams provider instance
   */
  getMSTeamsProvider(): MSTeamsProvider | null {
    if (!this.msTeamsProvider) {
      this.msTeamsProvider = new MSTeamsProvider();
      if (!this.msTeamsProvider.isConfigured()) {
        return null;
      }
    }
    return this.msTeamsProvider;
  }

  /**
   * Get a chatops provider by type
   */
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
   * Iterates through all provider types from the enum - TypeScript exhaustiveness
   * in getChatOpsProvider() ensures new providers are implemented when added.
   */
  isAnyProviderConfigured(): boolean {
    for (const providerType of ChatOpsProviderTypeSchema.options) {
      const provider = this.getChatOpsProvider(providerType);
      if (provider?.isConfigured()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Initialize all configured chatops providers
   */
  async initialize(): Promise<void> {
    // True no-op if no providers configured
    if (!this.isAnyProviderConfigured()) {
      return;
    }

    const providers: { name: string; provider: ChatOpsProvider | null }[] = [
      { name: "MS Teams", provider: this.getMSTeamsProvider() },
      // Add more providers here as they're implemented
    ];

    for (const { name, provider } of providers) {
      if (provider?.isConfigured()) {
        try {
          await provider.initialize();
          logger.info(`[ChatOps] ${name} provider initialized`);
        } catch (error) {
          logger.error(
            { error: error instanceof Error ? error.message : String(error) },
            `[ChatOps] Failed to initialize ${name} provider`,
          );
        }
      }
    }

    // Start cleanup job for processed messages
    this.startProcessedMessageCleanup();
  }

  /**
   * Cleanup all chatops providers
   */
  async cleanup(): Promise<void> {
    if (this.msTeamsProvider) {
      await this.msTeamsProvider.cleanup();
      this.msTeamsProvider = null;
    }
    this.stopCleanupInterval();
  }

  /**
   * Stop the cleanup job (for testing/shutdown)
   */
  stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Process an incoming chatops message.
   *
   * This is the main entry point for handling chatops messages:
   * 1. Check deduplication
   * 2. Look up channel binding
   * 3. Validate prompt exists and allows this provider
   * 4. Execute the agent via A2A executor
   * 5. Send reply
   */
  async processMessage(params: {
    message: IncomingChatMessage;
    provider: ChatOpsProvider;
    sendReply?: boolean;
  }): Promise<ChatOpsProcessingResult> {
    const { message, provider, sendReply = true } = params;

    // Check deduplication
    const isNew = await ChatOpsProcessedMessageModel.tryMarkAsProcessed(
      message.messageId,
    );
    if (!isNew) {
      logger.debug(
        { messageId: message.messageId },
        "[ChatOps] Message already processed, skipping",
      );
      return { success: true }; // Already processed, consider it a success
    }

    // Look up channel binding
    const binding = await ChatOpsChannelBindingModel.findByChannel({
      provider: provider.providerId,
      channelId: message.channelId,
      workspaceId: message.workspaceId,
    });

    if (!binding) {
      logger.debug(
        {
          provider: provider.providerId,
          channelId: message.channelId,
          workspaceId: message.workspaceId,
        },
        "[ChatOps] No binding found for channel",
      );
      // Return success but with a flag indicating no binding
      return {
        success: true,
        error: "NO_BINDING",
      };
    }

    // Verify the prompt exists
    const prompt = await PromptModel.findById(binding.promptId);
    if (!prompt) {
      logger.warn(
        { promptId: binding.promptId, bindingId: binding.id },
        "[ChatOps] Prompt not found for binding",
      );
      return {
        success: false,
        error: "PROMPT_NOT_FOUND",
      };
    }

    // Check if the prompt allows this chatops provider
    if (!prompt.allowedChatops?.includes(provider.providerId)) {
      logger.warn(
        {
          promptId: binding.promptId,
          provider: provider.providerId,
          allowedChatops: prompt.allowedChatops,
        },
        "[ChatOps] Prompt does not allow this chatops provider",
      );
      return {
        success: false,
        error: "PROVIDER_NOT_ALLOWED",
      };
    }

    // Check for inline agent mention (e.g., "@AgentName do something")
    const { agentToUse, cleanedMessageText, fallbackMessage } =
      await this.resolveInlineAgentMention({
        messageText: message.text,
        defaultPrompt: prompt,
        provider,
      });

    // Build context from thread history if available
    const contextMessages = await this.fetchThreadHistory(message, provider);

    // Build the full message with context (using cleaned text without agent mention)
    let fullMessage = cleanedMessageText;
    if (contextMessages.length > 0) {
      fullMessage = `Previous conversation:\n${contextMessages.join("\n")}\n\nUser: ${cleanedMessageText}`;
    }

    // Execute the A2A message using the resolved agent
    return this.executeAndReply({
      prompt: agentToUse,
      binding,
      message,
      provider,
      fullMessage,
      sendReply,
      fallbackMessage,
    });
  }

  /**
   * Start periodic cleanup of old processed message records
   */
  private startProcessedMessageCleanup(): void {
    if (this.cleanupInterval) {
      return; // Already started
    }

    // Run immediately on startup
    this.runCleanup();

    // Then run periodically
    this.cleanupInterval = setInterval(
      () => this.runCleanup(),
      CHATOPS_MESSAGE_RETENTION.CLEANUP_INTERVAL_MS,
    );
  }

  /**
   * Run cleanup of old processed message records
   */
  private async runCleanup(): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(
      cutoffDate.getDate() - CHATOPS_MESSAGE_RETENTION.RETENTION_DAYS,
    );

    try {
      await ChatOpsProcessedMessageModel.cleanupOldRecords(cutoffDate);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "[ChatOps] Failed to cleanup old processed messages",
      );
    }
  }

  /**
   * Resolve inline agent mention from message text.
   * Supports patterns like ">AgentName do something" to use a specific agent.
   * Tolerant matching: ">AgentPeter", "> AgentPeter", ">Agent Peter", "> Agent Peter"
   * all match an agent named "Agent Peter" (case-insensitive, space-tolerant).
   * If the mentioned agent is not found or not enabled, falls back to default.
   */
  private async resolveInlineAgentMention(params: {
    messageText: string;
    defaultPrompt: { id: string; name: string };
    provider: ChatOpsProvider;
  }): Promise<{
    agentToUse: { id: string; name: string };
    cleanedMessageText: string;
    fallbackMessage?: string;
  }> {
    const { messageText, defaultPrompt, provider } = params;

    // Check if message starts with > (agent mention prefix)
    if (!messageText.startsWith(">")) {
      return {
        agentToUse: defaultPrompt,
        cleanedMessageText: messageText,
      };
    }

    // Get text after the > symbol, trim leading space ("> Agent" -> "Agent")
    const textAfterPrefix = messageText.slice(1).trimStart();

    // Get all available agents for this provider to match against
    const availableAgents = await PromptModel.findByAllowedChatopsProvider(
      provider.providerId,
    );

    // Sort by name length (longest first) to match "Agent Peter" before "Agent"
    const sortedAgents = [...availableAgents].sort(
      (a, b) => b.name.length - a.name.length,
    );

    // Try to match the message start against known agent names
    for (const agent of sortedAgents) {
      // Try to find where the agent name ends in the message
      // Tolerant matching handles spaces and case variations
      const match = findTolerantMatch(textAfterPrefix, agent.name);

      if (match) {
        const cleanedMessageText = textAfterPrefix.slice(match.length).trim();

        logger.debug(
          { mentionedAgent: agent.name, defaultAgent: defaultPrompt.name },
          "[ChatOps] Using mentioned agent instead of default",
        );

        return {
          agentToUse: agent,
          cleanedMessageText,
        };
      }
    }

    // No known agent matched - extract the attempted mention for error message
    // Take everything up to the first newline or reasonable length
    const mentionEndMatch = textAfterPrefix.match(/^([^\n]{1,50})(?:\s|$)/);
    if (mentionEndMatch) {
      // Try to extract just the first word(s) that look like an agent name
      const potentialName = textAfterPrefix.split(/\s{2,}|\n/)[0].trim();
      const cleanedMessageText = textAfterPrefix
        .slice(potentialName.length)
        .trim();

      logger.debug(
        { mentionedAgentName: potentialName, defaultAgent: defaultPrompt.name },
        "[ChatOps] Mentioned agent not found, using default",
      );

      return {
        agentToUse: defaultPrompt,
        cleanedMessageText: cleanedMessageText || textAfterPrefix,
        fallbackMessage: `${potentialName} not found, using ${defaultPrompt.name}`,
      };
    }

    // Just a > with nothing useful after - use default
    return {
      agentToUse: defaultPrompt,
      cleanedMessageText: messageText,
    };
  }

  /**
   * Fetch thread history for context
   */
  private async fetchThreadHistory(
    message: IncomingChatMessage,
    provider: ChatOpsProvider,
  ): Promise<string[]> {
    // Debug: Log incoming message details for thread context
    logger.debug(
      {
        messageId: message.messageId,
        channelId: message.channelId,
        workspaceId: message.workspaceId,
        threadId: message.threadId,
        isThreadReply: message.isThreadReply,
      },
      "[ChatOps] fetchThreadHistory - message details",
    );

    if (!message.threadId) {
      logger.debug("[ChatOps] No threadId, skipping history fetch");
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
        {
          historyCount: history.length,
          messages: history.map((m) => ({
            sender: m.senderName,
            textPreview: m.text.substring(0, 50),
            isFromBot: m.isFromBot,
          })),
        },
        "[ChatOps] Thread history fetched",
      );

      return history.map((msg) => {
        let text = msg.text;

        // Strip footer from bot messages to avoid LLM repeating it
        if (msg.isFromBot) {
          text = stripBotFooter(text);
        }

        return `${msg.isFromBot ? "Assistant" : msg.senderName}: ${text}`;
      });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "[ChatOps] Failed to fetch thread history",
      );
      // Continue without history
      return [];
    }
  }

  /**
   * Execute A2A message and send reply
   */
  private async executeAndReply(params: {
    prompt: { id: string; name: string };
    binding: { organizationId: string };
    message: IncomingChatMessage;
    provider: ChatOpsProvider;
    fullMessage: string;
    sendReply: boolean;
    fallbackMessage?: string;
  }): Promise<ChatOpsProcessingResult> {
    const {
      prompt,
      binding,
      message,
      provider,
      fullMessage,
      sendReply,
      fallbackMessage,
    } = params;

    try {
      const result = await executeA2AMessage({
        promptId: prompt.id,
        organizationId: binding.organizationId,
        message: fullMessage,
        // Use a chatops-prefixed user ID to distinguish from regular users
        userId: `chatops-${provider.providerId}-${message.senderId}`,
      });

      const agentResponse = result.text || "";

      // Send reply
      if (sendReply && agentResponse) {
        // Build footer - include fallback message if agent mention wasn't found
        const footer = fallbackMessage
          ? `${fallbackMessage}`
          : `Via ${prompt.name}`;

        await provider.sendReply({
          originalMessage: message,
          text: agentResponse,
          footer,
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
        {
          messageId: message.messageId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "[ChatOps] Failed to execute A2A message",
      );

      if (sendReply) {
        await provider.sendReply({
          originalMessage: message,
          text: "Sorry, I encountered an error processing your request.",
          conversationReference: message.metadata?.conversationReference,
        });
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// Singleton instance
export const chatOpsManager = new ChatOpsManager();

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Strip the bot footer from message text to avoid LLM repeating it.
 * Footer formats:
 * - "Via AgentName" (normal)
 * - "AgentX not found, using AgentY" (fallback)
 * Teams may return this in various HTML formats.
 */
function stripBotFooter(text: string): string {
  // Match the footer pattern in various formats Teams might use
  return (
    text
      // Markdown format: "\n\n---\n_Via AgentName_" or "\n\n---\n_X not found, using Y_"
      .replace(/\n\n---\n_Via .+?_$/i, "")
      .replace(/\n\n---\n_.+? not found, using .+?_$/i, "")
      // HTML with <hr> and <em>
      .replace(/<hr\s*\/?>\s*<em>Via .+?<\/em>$/i, "")
      .replace(/<hr\s*\/?>\s*<em>.+? not found, using .+?<\/em>$/i, "")
      // Plain text at end of message (after stripping HTML)
      .replace(/\s*Via .+?$/i, "")
      .replace(/\s*.+? not found, using .+?$/i, "")
      .trim()
  );
}

/**
 * Find a tolerant match for an agent name at the start of text.
 * Handles variations like "AgentPeter", "Agent Peter", "agent peter" for "Agent Peter".
 * Returns the match object with the length of matched text, or null if no match.
 */
function findTolerantMatch(
  text: string,
  agentName: string,
): { length: number } | null {
  const lowerText = text.toLowerCase();
  const lowerName = agentName.toLowerCase();

  // Strategy 1: Exact match (with spaces)
  if (lowerText.startsWith(lowerName)) {
    const charAfter = text[agentName.length];
    if (charAfter === undefined || charAfter === " " || charAfter === "\n") {
      return { length: agentName.length };
    }
  }

  // Strategy 2: Match without spaces (e.g., "agentpeter" matches "Agent Peter")
  const nameWithoutSpaces = lowerName.replace(/\s+/g, "");

  // Walk through the text, matching characters from nameWithoutSpaces
  // while allowing optional spaces in the text
  let textIdx = 0;
  let nameIdx = 0;

  while (nameIdx < nameWithoutSpaces.length && textIdx < text.length) {
    const textChar = lowerText[textIdx];
    const nameChar = nameWithoutSpaces[nameIdx];

    if (textChar === nameChar) {
      textIdx++;
      nameIdx++;
    } else if (textChar === " ") {
      // Skip spaces in text
      textIdx++;
    } else {
      // Mismatch
      return null;
    }
  }

  // Check if we matched the full agent name
  if (nameIdx === nameWithoutSpaces.length) {
    // Make sure we're at a word boundary
    const charAfter = text[textIdx];
    if (charAfter === undefined || charAfter === " " || charAfter === "\n") {
      return { length: textIdx };
    }
  }

  return null;
}
