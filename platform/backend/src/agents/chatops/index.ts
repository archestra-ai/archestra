import { executeA2AMessage } from "@/agents/a2a-executor";
import logger from "@/logging";
import {
  ChatOpsChannelBindingModel,
  ChatOpsProcessedMessageModel,
  PromptModel,
} from "@/models";
import type {
  ChatOpsProcessingResult,
  ChatOpsProvider,
  ChatOpsProviderType,
  IncomingChatMessage,
} from "@/types/chatops";
import { CHATOPS_MESSAGE_RETENTION } from "./constants";
import MSTeamsProvider from "./ms-teams-provider";

// Provider instances (lazy initialized)
let msTeamsProvider: MSTeamsProvider | null = null;

/**
 * Get the MS Teams provider instance
 */
export function getMSTeamsProvider(): MSTeamsProvider | null {
  if (!msTeamsProvider) {
    msTeamsProvider = new MSTeamsProvider();
    if (!msTeamsProvider.isConfigured()) {
      return null;
    }
  }
  return msTeamsProvider;
}

/**
 * Get a chatops provider by type
 */
export function getChatOpsProvider(
  providerType: ChatOpsProviderType,
): ChatOpsProvider | null {
  switch (providerType) {
    case "ms-teams":
      return getMSTeamsProvider();
    case "slack":
      // TODO: Implement SlackProvider
      logger.warn("[ChatOps] Slack provider not yet implemented");
      return null;
    case "discord":
      // TODO: Implement DiscordProvider
      logger.warn("[ChatOps] Discord provider not yet implemented");
      return null;
    default:
      return null;
  }
}

/**
 * Initialize all configured chatops providers
 */
export async function initializeChatOpsProviders(): Promise<void> {
  const providers: { name: string; provider: ChatOpsProvider | null }[] = [
    { name: "MS Teams", provider: getMSTeamsProvider() },
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
  startProcessedMessageCleanup();
}

/**
 * Cleanup all chatops providers
 */
export async function cleanupChatOpsProviders(): Promise<void> {
  if (msTeamsProvider) {
    await msTeamsProvider.cleanup();
    msTeamsProvider = null;
  }
}

/**
 * Start periodic cleanup of old processed message records
 */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startProcessedMessageCleanup(): void {
  if (cleanupInterval) {
    return; // Already started
  }

  const runCleanup = async () => {
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
  };

  // Run immediately on startup
  runCleanup();

  // Then run periodically
  cleanupInterval = setInterval(
    runCleanup,
    CHATOPS_MESSAGE_RETENTION.CLEANUP_INTERVAL_MS,
  );
}

/**
 * Stop the cleanup job (for testing/shutdown)
 */
export function stopProcessedMessageCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
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
export async function processChatOpsMessage(params: {
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

  if (!binding.enabled) {
    logger.debug(
      { bindingId: binding.id },
      "[ChatOps] Binding is disabled, skipping",
    );
    return { success: true };
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
  let contextMessages: string[] = [];
  if (message.threadId) {
    try {
      const history = await provider.getThreadHistory({
        channelId: message.channelId,
        workspaceId: message.workspaceId,
        threadId: message.threadId,
        excludeMessageId: message.messageId,
      });

      contextMessages = history.map(
        (msg) => `${msg.isFromBot ? "Assistant" : msg.senderName}: ${msg.text}`,
      );
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "[ChatOps] Failed to fetch thread history",
      );
      // Continue without history
    }
  }

  // Build the full message with context
  let fullMessage = message.text;
  if (contextMessages.length > 0) {
    fullMessage = `Previous conversation:\n${contextMessages.join("\n")}\n\nUser: ${message.text}`;
  }

  // Execute the A2A message using the prompt
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

// Export types
export type { ChatOpsProvider, ChatOpsProviderType, IncomingChatMessage };

// Export provider class for direct use
export { MSTeamsProvider };

// Export constants
export * from "./constants";
