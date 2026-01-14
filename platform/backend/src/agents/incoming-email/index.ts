import config from "@/config";
import logger from "@/logging";
import IncomingEmailSubscriptionModel from "@/models/incoming-email-subscription";
import type {
  AgentIncomingEmailProvider,
  EmailProviderConfig,
  EmailProviderType,
  SubscriptionInfo,
} from "@/types";
import { OutlookEmailProvider } from "./outlook-provider";

export type {
  AgentIncomingEmailProvider,
  EmailProviderConfig,
  EmailProviderType,
  IncomingEmail,
  SubscriptionInfo,
} from "@/types";
export { OutlookEmailProvider } from "./outlook-provider";

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
