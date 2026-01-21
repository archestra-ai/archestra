import { executeA2AMessage } from "@/agents/a2a-executor";
import { userHasPermission } from "@/auth";
import config from "@/config";
import logger from "@/logging";
import AgentTeamModel from "@/models/agent-team";
import IncomingEmailSubscriptionModel from "@/models/incoming-email-subscription";
import ProcessedEmailModel from "@/models/processed-email";
import PromptModel from "@/models/prompt";
import TeamModel from "@/models/team";
import UserModel from "@/models/user";
import type {
  AgentIncomingEmailProvider,
  EmailProviderConfig,
  EmailProviderType,
  IncomingEmail,
  SubscriptionInfo,
} from "@/types";
import {
  DEFAULT_AGENT_EMAIL_NAME,
  MAX_EMAIL_BODY_SIZE,
  PROCESSED_EMAIL_RETENTION_MS,
} from "./constants";
import { OutlookEmailProvider } from "./outlook-provider";

export type {
  AgentIncomingEmailProvider,
  ConversationMessage,
  EmailProviderConfig,
  EmailProviderType,
  EmailReplyOptions,
  IncomingEmail,
  SubscriptionInfo,
} from "@/types";
export {
  EMAIL_SUBSCRIPTION_RENEWAL_INTERVAL,
  MAX_EMAIL_BODY_SIZE,
  PROCESSED_EMAIL_CLEANUP_INTERVAL_MS,
  PROCESSED_EMAIL_RETENTION_MS,
} from "./constants";
export { OutlookEmailProvider } from "./outlook-provider";

/**
 * Atomically check and mark an email as processed using database.
 * Uses INSERT with unique constraint for distributed deduplication across pods.
 *
 * @param messageId - The email provider's message ID
 * @returns true if successfully marked (first to process), false if already processed
 */
export async function tryMarkEmailAsProcessed(
  messageId: string,
): Promise<boolean> {
  return ProcessedEmailModel.tryMarkAsProcessed(messageId);
}

/**
 * Clean up old processed email records.
 * Should be called periodically to prevent unbounded table growth.
 */
export async function cleanupOldProcessedEmails(): Promise<void> {
  const olderThan = new Date(Date.now() - PROCESSED_EMAIL_RETENTION_MS);
  await ProcessedEmailModel.cleanupOldRecords(olderThan);
}

/**
 * Singleton instance of the configured email provider
 */
let emailProviderInstance: AgentIncomingEmailProvider | null = null;

/**
 * Get the email provider configuration from environment variables
 */
export function getEmailProviderConfig(): EmailProviderConfig {
  return config.agents.incomingEmail;
}

/**
 * Check if the incoming email feature is enabled
 */
export function isIncomingEmailEnabled(): boolean {
  const providerConfig = getEmailProviderConfig();
  return providerConfig.provider !== undefined;
}

/**
 * Get the configured email provider type
 */
export function getEmailProviderType(): EmailProviderType | undefined {
  return getEmailProviderConfig().provider;
}

/**
 * Create an email provider instance based on configuration
 */
export function createEmailProvider(
  providerType: EmailProviderType,
  providerConfig: EmailProviderConfig,
): AgentIncomingEmailProvider {
  switch (providerType) {
    case "outlook": {
      if (!providerConfig.outlook) {
        throw new Error("Outlook provider configuration is missing");
      }
      return new OutlookEmailProvider(providerConfig.outlook);
    }
    default:
      throw new Error(`Unknown email provider type: ${providerType}`);
  }
}

/**
 * Flag to track if we've already attempted initialization
 * Prevents repeated initialization attempts for unconfigured providers
 */
let providerInitializationAttempted = false;

/**
 * Get the configured email provider instance (singleton)
 * Returns null if no provider is configured
 */
export function getEmailProvider(): AgentIncomingEmailProvider | null {
  // Return cached instance if available
  if (emailProviderInstance) {
    return emailProviderInstance;
  }

  // If we've already tried and failed, don't retry
  if (providerInitializationAttempted) {
    return null;
  }

  const providerConfig = getEmailProviderConfig();
  if (!providerConfig.provider) {
    providerInitializationAttempted = true;
    return null;
  }

  try {
    const provider = createEmailProvider(
      providerConfig.provider,
      providerConfig,
    );

    if (!provider.isConfigured()) {
      logger.warn(
        { provider: providerConfig.provider },
        "[IncomingEmail] Provider is not fully configured",
      );
      providerInitializationAttempted = true;
      return null;
    }

    // Only cache if successfully configured
    emailProviderInstance = provider;
    providerInitializationAttempted = true;
    return emailProviderInstance;
  } catch (error) {
    logger.error(
      {
        provider: providerConfig.provider,
        error: error instanceof Error ? error.message : String(error),
      },
      "[IncomingEmail] Failed to create email provider",
    );
    providerInitializationAttempted = true;
    return null;
  }
}

/**
 * Auto-setup subscription with retry logic
 * Retries with exponential backoff if webhook validation fails (e.g., tunnel not ready)
 */
async function autoSetupSubscriptionWithRetry(
  provider: OutlookEmailProvider,
  webhookUrl: string,
  maxRetries = 5,
  initialDelayMs = 5000,
): Promise<void> {
  let attempt = 0;
  let delayMs = initialDelayMs;

  while (attempt < maxRetries) {
    attempt++;

    // Check if there's already an active subscription (might have been created manually)
    const existingSubscription =
      await IncomingEmailSubscriptionModel.getActiveSubscription();

    if (existingSubscription) {
      logger.info(
        {
          subscriptionId: existingSubscription.subscriptionId,
          expiresAt: existingSubscription.expiresAt,
        },
        "[IncomingEmail] Active subscription already exists, stopping auto-setup retries",
      );
      return;
    }

    try {
      logger.info(
        { webhookUrl, attempt, maxRetries },
        "[IncomingEmail] Auto-creating subscription from env var config",
      );

      // Clean up ALL existing subscriptions from Microsoft Graph first
      // This prevents stale subscriptions from causing clientState mismatch errors
      const deleted = await provider.deleteAllGraphSubscriptions();
      if (deleted > 0) {
        logger.info(
          { deleted },
          "[IncomingEmail] Cleaned up existing Graph subscriptions before auto-setup",
        );
      }

      const subscription = await provider.createSubscription(webhookUrl);
      logger.info(
        {
          subscriptionId: subscription.subscriptionId,
          expiresAt: subscription.expiresAt,
        },
        "[IncomingEmail] Auto-setup subscription created successfully",
      );
      return; // Success!
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const isValidationError =
        errorMessage.includes("validation request failed") ||
        errorMessage.includes("BadGateway") ||
        errorMessage.includes("502");

      if (isValidationError && attempt < maxRetries) {
        logger.warn(
          {
            webhookUrl,
            attempt,
            maxRetries,
            nextRetryInMs: delayMs,
            error: errorMessage,
          },
          "[IncomingEmail] Webhook validation failed, will retry (tunnel may not be ready yet)",
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 60000); // Exponential backoff, max 1 minute
      } else {
        logger.error(
          {
            webhookUrl,
            attempt,
            error: errorMessage,
          },
          "[IncomingEmail] Auto-setup subscription failed",
        );
        return; // Give up on non-validation errors or max retries reached
      }
    }
  }

  logger.error(
    { webhookUrl, maxRetries },
    "[IncomingEmail] Auto-setup subscription failed after all retries",
  );
}

/**
 * Initialize the email provider (call on server startup)
 * If webhookUrl is configured, automatically creates subscription
 */
export async function initializeEmailProvider(): Promise<void> {
  const provider = getEmailProvider();
  if (!provider) {
    logger.info(
      "[IncomingEmail] No email provider configured, skipping initialization",
    );
    return;
  }

  try {
    await provider.initialize();
    logger.info(
      { provider: provider.providerId },
      "[IncomingEmail] Email provider initialized successfully",
    );
  } catch (error) {
    logger.error(
      {
        provider: provider.providerId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[IncomingEmail] Failed to initialize email provider",
    );
    // Don't throw - allow server to start even if email provider fails
    return;
  }

  // Auto-setup subscription if webhookUrl is configured
  // Run in background with retries to handle tunnel not being ready
  const providerConfig = getEmailProviderConfig();
  const webhookUrl = providerConfig.outlook?.webhookUrl;

  if (webhookUrl && provider instanceof OutlookEmailProvider) {
    // Fire and forget - don't block server startup
    autoSetupSubscriptionWithRetry(provider, webhookUrl).catch((error) => {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "[IncomingEmail] Unexpected error in auto-setup background task",
      );
    });
  }
}

/**
 * Renew subscription if it's about to expire (within 24 hours)
 * Called periodically by background job
 */
export async function renewEmailSubscriptionIfNeeded(): Promise<void> {
  const provider = getEmailProvider();
  if (!provider || !(provider instanceof OutlookEmailProvider)) {
    return;
  }

  const subscription =
    await IncomingEmailSubscriptionModel.getActiveSubscription();
  if (!subscription) {
    logger.debug("[IncomingEmail] No active subscription to renew");
    return;
  }

  // Check if subscription expires within 24 hours
  const now = new Date();
  const expiresAt = subscription.expiresAt;
  const hoursUntilExpiry =
    (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);

  if (hoursUntilExpiry <= 24) {
    logger.info(
      {
        subscriptionId: subscription.subscriptionId,
        hoursUntilExpiry: hoursUntilExpiry.toFixed(1),
      },
      "[IncomingEmail] Subscription expiring soon, renewing",
    );

    try {
      const newExpiresAt = await provider.renewSubscription(
        subscription.subscriptionId,
      );
      logger.info(
        {
          subscriptionId: subscription.subscriptionId,
          newExpiresAt,
        },
        "[IncomingEmail] Subscription renewed successfully",
      );
    } catch (error) {
      logger.error(
        {
          subscriptionId: subscription.subscriptionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "[IncomingEmail] Failed to renew subscription",
      );
    }
  }
}

/**
 * Get the current subscription status
 */
export async function getSubscriptionStatus(): Promise<SubscriptionInfo | null> {
  const provider = getEmailProvider();
  if (!provider || !(provider instanceof OutlookEmailProvider)) {
    return null;
  }

  return provider.getSubscriptionStatus();
}

/**
 * Cleanup the email provider (call on server shutdown)
 */
export async function cleanupEmailProvider(): Promise<void> {
  if (emailProviderInstance) {
    try {
      await emailProviderInstance.cleanup();
      logger.info(
        { provider: emailProviderInstance.providerId },
        "[IncomingEmail] Email provider cleaned up",
      );
    } catch (error) {
      logger.warn(
        {
          provider: emailProviderInstance.providerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "[IncomingEmail] Error during email provider cleanup",
      );
    }
    emailProviderInstance = null;
  }
  // Reset the initialization flag to allow reinitialization after cleanup
  providerInitializationAttempted = false;
}

/**
 * Generate an email address for an agent (prompt)
 * Returns null if no provider is configured
 */
export function generateAgentEmailAddress(promptId: string): string | null {
  const provider = getEmailProvider();
  if (!provider) {
    return null;
  }

  return provider.generateEmailAddress(promptId);
}

/**
 * Get email provider information for the features endpoint
 */
export function getEmailProviderInfo(): {
  enabled: boolean;
  provider: EmailProviderType | undefined;
  displayName: string | undefined;
  emailDomain: string | undefined;
} {
  const provider = getEmailProvider();

  if (!provider) {
    return {
      enabled: false,
      provider: undefined,
      displayName: undefined,
      emailDomain: undefined,
    };
  }

  return {
    enabled: true,
    provider: provider.providerId as EmailProviderType,
    displayName: provider.displayName,
    emailDomain: provider.getEmailDomain(),
  };
}

/**
 * Options for processing incoming emails
 */
export interface ProcessIncomingEmailOptions {
  /**
   * Whether to send the agent's response back via email reply
   * @default false
   */
  sendReply?: boolean;
}

/**
 * Process an incoming email and invoke the appropriate agent
 * @param email - The incoming email to process
 * @param provider - The email provider instance
 * @param options - Optional processing options
 * @returns The agent's response text if sendReply is enabled
 */
export async function processIncomingEmail(
  email: IncomingEmail,
  provider: AgentIncomingEmailProvider | null,
  options: ProcessIncomingEmailOptions = {},
): Promise<string | undefined> {
  const { sendReply: shouldSendReply = false } = options;
  if (!provider) {
    throw new Error("No email provider configured");
  }

  // Atomic deduplication: try to mark email as processed using database unique constraint
  // This prevents race conditions when multiple pods receive the same webhook notification
  const isFirstToProcess = await tryMarkEmailAsProcessed(email.messageId);
  if (!isFirstToProcess) {
    logger.info(
      { messageId: email.messageId },
      "[IncomingEmail] Skipping duplicate email (already processed by another pod)",
    );
    return undefined;
  }

  logger.info(
    {
      messageId: email.messageId,
      toAddress: email.toAddress,
      fromAddress: email.fromAddress,
      subject: email.subject,
    },
    "[IncomingEmail] Processing incoming email",
  );

  // Extract promptId from the email address
  let promptId: string | null = null;

  if (provider.providerId === "outlook") {
    const outlookProvider = provider as OutlookEmailProvider;
    promptId = outlookProvider.extractPromptIdFromEmail(email.toAddress);
  }

  if (!promptId) {
    throw new Error(
      `Could not extract promptId from email address: ${email.toAddress}`,
    );
  }

  // Get prompt
  const prompt = await PromptModel.findById(promptId);
  if (!prompt) {
    throw new Error(`Prompt ${promptId} not found`);
  }

  // Check if incoming email is enabled for this prompt
  if (!prompt.incomingEmailEnabled) {
    logger.warn(
      {
        messageId: email.messageId,
        promptId,
        agentId: prompt.agentId,
        fromAddress: email.fromAddress,
      },
      "[IncomingEmail] Incoming email is not enabled for this agent",
    );
    throw new Error(`Incoming email is not enabled for agent ${prompt.name}`);
  }

  // Apply security mode validation
  const securityMode = prompt.incomingEmailSecurityMode;
  const senderEmail = email.fromAddress.toLowerCase();

  logger.debug(
    {
      messageId: email.messageId,
      agentId: prompt.agentId,
      securityMode,
      senderEmail,
    },
    "[IncomingEmail] Applying security mode validation",
  );

  // Determine userId for the request (used for 'private' mode)
  let userId: string = "system";

  switch (securityMode) {
    case "private": {
      // Private mode: Sender must be an Archestra user with access to the agent
      const user = await UserModel.findByEmail(senderEmail);
      if (!user) {
        logger.warn(
          {
            messageId: email.messageId,
            agentId: prompt.agentId,
            senderEmail,
          },
          "[IncomingEmail] Private mode: sender email not found in Archestra users",
        );
        throw new Error(
          `Unauthorized: email sender ${senderEmail} is not a registered Archestra user`,
        );
      }

      // Check if user is a profile admin (can access all agents)
      const isProfileAdmin = await userHasPermission(
        user.id,
        prompt.organizationId,
        "profile",
        "admin",
      );

      // Check if user has access to the agent via team membership or admin permission
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        user.id,
        prompt.agentId,
        isProfileAdmin,
      );

      if (!hasAccess) {
        logger.warn(
          {
            messageId: email.messageId,
            agentId: prompt.agentId,
            userId: user.id,
            senderEmail,
            isProfileAdmin,
          },
          "[IncomingEmail] Private mode: user does not have access to this agent",
        );
        throw new Error(
          `Unauthorized: user ${senderEmail} does not have access to this agent`,
        );
      }

      // Use the verified user ID for execution context
      userId = user.id;

      logger.info(
        {
          messageId: email.messageId,
          agentId: prompt.agentId,
          userId: user.id,
          senderEmail,
          isProfileAdmin,
        },
        "[IncomingEmail] Private mode: sender authenticated via email",
      );
      break;
    }

    case "internal": {
      // Internal mode: Sender email domain must match the allowed domain
      const allowedDomain = prompt.incomingEmailAllowedDomain?.toLowerCase();
      if (!allowedDomain) {
        throw new Error(
          `Internal mode is configured but no allowed domain is set for agent ${prompt.name}`,
        );
      }

      const senderDomain = senderEmail.split("@")[1];
      if (!senderDomain || senderDomain !== allowedDomain) {
        logger.warn(
          {
            messageId: email.messageId,
            agentId: prompt.agentId,
            senderEmail,
            senderDomain,
            allowedDomain,
          },
          "[IncomingEmail] Internal mode: sender domain not allowed",
        );
        throw new Error(
          `Unauthorized: emails from domain ${senderDomain} are not allowed for this agent. Only @${allowedDomain} is permitted.`,
        );
      }

      logger.info(
        {
          messageId: email.messageId,
          agentId: prompt.agentId,
          senderEmail,
          allowedDomain,
        },
        "[IncomingEmail] Internal mode: sender domain verified",
      );
      break;
    }

    case "public": {
      // Public mode: No restrictions on sender
      logger.info(
        {
          messageId: email.messageId,
          agentId: prompt.agentId,
          senderEmail,
        },
        "[IncomingEmail] Public mode: allowing email from any sender",
      );
      break;
    }

    default: {
      // Unknown security mode - treat as private (most restrictive)
      logger.warn(
        {
          messageId: email.messageId,
          agentId: prompt.agentId,
          securityMode,
        },
        "[IncomingEmail] Unknown security mode, treating as private",
      );
      throw new Error(
        `Unknown security mode: ${securityMode}. Email rejected for security.`,
      );
    }
  }

  // Get organization from agent's team
  const agentTeamIds = await AgentTeamModel.getTeamsForAgent(prompt.agentId);
  if (agentTeamIds.length === 0) {
    throw new Error(`No teams found for agent ${prompt.agentId}`);
  }

  const teams = await TeamModel.findByIds(agentTeamIds);
  if (teams.length === 0 || !teams[0].organizationId) {
    throw new Error(`No organization found for agent ${prompt.agentId}`);
  }
  const organization = teams[0].organizationId;

  // Fetch conversation history if this is part of a thread
  let conversationContext = "";
  if (email.conversationId && provider.getConversationHistory) {
    try {
      const history = await provider.getConversationHistory(
        email.conversationId,
        email.messageId,
      );

      if (history.length > 0) {
        logger.info(
          {
            messageId: email.messageId,
            conversationId: email.conversationId,
            historyCount: history.length,
          },
          "[IncomingEmail] Including conversation history in agent context",
        );

        // Format conversation history for the agent
        const formattedHistory = history
          .map((msg) => {
            const role = msg.isAgentMessage ? "You (Agent)" : "User";
            const name = msg.fromName ? ` (${msg.fromName})` : "";
            return `[${role}${name}]: ${msg.body.trim()}`;
          })
          .join("\n\n---\n\n");

        conversationContext = `<conversation_history>
The following is the previous conversation in this email thread. Use this context to understand the full conversation.

${formattedHistory}
</conversation_history>

`;
      }
    } catch (error) {
      logger.warn(
        {
          messageId: email.messageId,
          conversationId: email.conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        "[IncomingEmail] Failed to fetch conversation history, continuing without it",
      );
    }
  }

  // Use email body as the message to invoke the agent
  // If body is empty, use the subject line
  const currentMessage =
    email.body.trim() || email.subject || "No message content";

  // Combine conversation context with current message
  let message = conversationContext
    ? `${conversationContext}[Current message from user]: ${currentMessage}`
    : currentMessage;

  // Truncate message if it exceeds the maximum size to prevent excessive LLM context usage
  if (Buffer.byteLength(message, "utf8") > MAX_EMAIL_BODY_SIZE) {
    // Truncate to MAX_EMAIL_BODY_SIZE bytes and add truncation notice
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf8", { fatal: false });
    const encoded = encoder.encode(message);
    const truncated = decoder.decode(encoded.slice(0, MAX_EMAIL_BODY_SIZE));
    message = `${truncated}\n\n[Message truncated - original size exceeded ${
      MAX_EMAIL_BODY_SIZE / 1024
    }KB limit]`;
    logger.warn(
      {
        messageId: email.messageId,
        originalSize: Buffer.byteLength(email.body, "utf8"),
        maxSize: MAX_EMAIL_BODY_SIZE,
      },
      "[IncomingEmail] Email body truncated due to size limit",
    );
  }

  logger.info(
    {
      promptId,
      agentId: prompt.agentId,
      organizationId: organization,
      messageLength: message.length,
      hasConversationHistory: conversationContext.length > 0,
    },
    "[IncomingEmail] Invoking agent with email content",
  );

  // Execute using the shared A2A service
  // userId is determined by security mode:
  // - private: actual user ID from email lookup
  // - internal/public: "system" (anonymous)
  const result = await executeA2AMessage({
    promptId,
    message,
    organizationId: organization,
    userId,
  });

  logger.info(
    {
      promptId,
      messageId: result.messageId,
      responseLength: result.text.length,
      finishReason: result.finishReason,
    },
    "[IncomingEmail] Agent execution completed",
  );

  // Optionally send the agent's response back via email reply
  if (shouldSendReply && result.text) {
    try {
      // Use the prompt (agent) name for the email reply
      const agentName = prompt.name || DEFAULT_AGENT_EMAIL_NAME;

      const replyId = await provider.sendReply({
        originalEmail: email,
        body: result.text,
        agentName,
      });

      logger.info(
        {
          promptId,
          originalMessageId: email.messageId,
          replyId,
        },
        "[IncomingEmail] Sent email reply with agent response",
      );
    } catch (error) {
      // Log but don't fail the entire operation if reply fails
      logger.error(
        {
          promptId,
          originalMessageId: email.messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        "[IncomingEmail] Failed to send email reply",
      );
    }

    return result.text;
  }

  // No reply sent - return undefined explicitly for clarity
  return undefined;
}
