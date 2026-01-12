import config from "@/config";
import logger from "@/logging";
import { OutlookEmailProvider } from "./outlook-provider";
import type {
  AgentIncomingEmailProvider,
  EmailProviderConfig,
  EmailProviderType,
} from "./types";

export { OutlookEmailProvider } from "./outlook-provider";
export * from "./types";

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
 * Get the configured email provider instance (singleton)
 * Returns null if no provider is configured
 */
export function getEmailProvider(): AgentIncomingEmailProvider | null {
  if (emailProviderInstance) {
    return emailProviderInstance;
  }

  const providerConfig = getEmailProviderConfig();
  if (!providerConfig.provider) {
    return null;
  }

  try {
    emailProviderInstance = createEmailProvider(
      providerConfig.provider,
      providerConfig,
    );

    if (!emailProviderInstance.isConfigured()) {
      logger.warn(
        { provider: providerConfig.provider },
        "[IncomingEmail] Provider is not fully configured",
      );
      return null;
    }

    return emailProviderInstance;
  } catch (error) {
    logger.error(
      {
        provider: providerConfig.provider,
        error: error instanceof Error ? error.message : String(error),
      },
      "[IncomingEmail] Failed to create email provider",
    );
    return null;
  }
}

/**
 * Initialize the email provider (call on server startup)
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
  }
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
