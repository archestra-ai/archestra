import { CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { AgentTeamModel, PromptModel, TeamModel } from "@/models";
import IncomingEmailSubscriptionModel from "@/models/incoming-email-subscription";
import { executeA2AMessage } from "@/services/a2a-executor";
import type {
  AgentIncomingEmailProvider,
  EmailProviderConfig,
  EmailProviderType,
  IncomingEmail,
  SubscriptionInfo,
} from "@/types";
import { EMAIL_DEDUP_CACHE_TTL_MS } from "./constants";
import { OutlookEmailProvider } from "./outlook-provider";

export type {
  AgentIncomingEmailProvider,
  EmailProviderConfig,
  EmailProviderType,
  IncomingEmail,
  SubscriptionInfo,
} from "@/types";
export {
  EMAIL_DEDUP_CACHE_TTL_MS,
  EMAIL_SUBSCRIPTION_RENEWAL_INTERVAL,
  MAX_EMAIL_BODY_SIZE,
} from "./constants";
export { OutlookEmailProvider } from "./outlook-provider";

/**
 * Check if an email has already been processed recently
 * Uses the shared CacheManager for TTL-based caching
 */
export async function isEmailAlreadyProcessed(
  messageId: string,
): Promise<boolean> {
  const cacheKey = `${CacheKey.ProcessedEmail}-${messageId}` as const;
  const cached = await cacheManager.get<boolean>(cacheKey);
  return cached === true;
}

/**
 * Mark an email as processed with TTL
 */
export async function markEmailAsProcessed(messageId: string): Promise<void> {
  const cacheKey = `${CacheKey.ProcessedEmail}-${messageId}` as const;
  await cacheManager.set(cacheKey, true, EMAIL_DEDUP_CACHE_TTL_MS);
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
 * Process an incoming email and invoke the appropriate agent
 */
export async function processIncomingEmail(
  email: IncomingEmail,
  provider: AgentIncomingEmailProvider | null,
): Promise<void> {
  if (!provider) {
    throw new Error("No email provider configured");
  }

  // Deduplication: check if we've already processed this email recently
  // Microsoft Graph may send multiple notifications for the same email
  if (await isEmailAlreadyProcessed(email.messageId)) {
    logger.info(
      { messageId: email.messageId },
      "[IncomingEmail] Skipping duplicate email (already processed recently)",
    );
    return;
  }

  // Mark as processed immediately to prevent concurrent processing
  await markEmailAsProcessed(email.messageId);

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

  // Verify prompt exists
  const prompt = await PromptModel.findById(promptId);
  if (!prompt) {
    throw new Error(`Prompt ${promptId} not found`);
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

  // Use email body as the message to invoke the agent
  // If body is empty, use the subject line
  let message = email.body.trim() || email.subject || "No message content";

  // Truncate message if it exceeds the maximum size to prevent excessive LLM context usage
  const { MAX_EMAIL_BODY_SIZE } = await import("./constants");
  if (Buffer.byteLength(message, "utf8") > MAX_EMAIL_BODY_SIZE) {
    // Truncate to MAX_EMAIL_BODY_SIZE bytes and add truncation notice
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf8", { fatal: false });
    const encoded = encoder.encode(message);
    const truncated = decoder.decode(encoded.slice(0, MAX_EMAIL_BODY_SIZE));
    message = `${truncated}\n\n[Message truncated - original size exceeded ${MAX_EMAIL_BODY_SIZE / 1024}KB limit]`;
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
    },
    "[IncomingEmail] Invoking agent with email content",
  );

  // Execute using the shared A2A service
  const result = await executeA2AMessage({
    promptId,
    message,
    organizationId: organization,
    userId: "system", // Email invocations use system context
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

  // TODO: Optionally send the response back via email
  // This would require implementing reply functionality in the provider
}
