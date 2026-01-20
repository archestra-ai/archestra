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

    // Build context from thread history if available
    const contextMessages = await this.fetchThreadHistory(message, provider);

    // Build the full message with context
    let fullMessage = message.text;
    if (contextMessages.length > 0) {
      fullMessage = `Previous conversation:\n${contextMessages.join("\n")}\n\nUser: ${message.text}`;
    }

    // Execute the A2A message using the prompt
    return this.executeAndReply({
      prompt,
      binding,
      message,
      provider,
      fullMessage,
      sendReply,
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
   * Fetch thread history for context
   */
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
  }): Promise<ChatOpsProcessingResult> {
    const { prompt, binding, message, provider, fullMessage, sendReply } =
      params;

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
        await provider.sendReply({
          originalMessage: message,
          text: agentResponse,
          footer: `Routed to ${prompt.name}. Use @Archestra /select-agent to change.`,
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
 * The footer format is: "\n\n---\n_Routed to X. Use @Archestra /select-agent to change._"
 * Teams may return this in various HTML formats.
 */
function stripBotFooter(text: string): string {
  // Match the footer pattern in various formats Teams might use
  return (
    text
      // Markdown format
      .replace(
        /\n\n---\n_Routed to .+?\. Use @Archestra \/select-agent to change\._$/i,
        "",
      )
      // HTML with <hr> and <em>
      .replace(
        /<hr\s*\/?>\s*<em>Routed to .+?\. Use @Archestra \/select-agent to change\.<\/em>$/i,
        "",
      )
      // Plain text "Routed to..." at end of message (after stripping HTML)
      .replace(
        /\s*Routed to .+?\. Use @Archestra \/select-agent to change\.$/i,
        "",
      )
      .trim()
  );
}
