import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";
import logger from "@/logging";
import type {
  AgentIncomingEmailProvider,
  EmailProviderConfig,
  IncomingEmail,
} from "./types";

/**
 * Microsoft Outlook/Exchange email provider using Microsoft Graph API
 *
 * This provider:
 * 1. Uses Microsoft Graph API subscriptions to receive notifications
 * 2. Generates agent email addresses using plus-addressing (user+promptId@domain.com)
 * 3. Retrieves full email content when notifications arrive
 */
export class OutlookEmailProvider implements AgentIncomingEmailProvider {
  readonly providerId = "outlook" as const;
  readonly displayName = "Microsoft Outlook";

  private config: NonNullable<EmailProviderConfig["outlook"]>;
  private graphClient: Client | null = null;
  private subscriptionId: string | null = null;

  constructor(config: NonNullable<EmailProviderConfig["outlook"]>) {
    this.config = config;
  }

  isConfigured(): boolean {
    return !!(
      this.config.tenantId &&
      this.config.clientId &&
      this.config.clientSecret &&
      this.config.mailboxAddress
    );
  }

  private getGraphClient(): Client {
    if (this.graphClient) {
      return this.graphClient;
    }

    const credential = new ClientSecretCredential(
      this.config.tenantId,
      this.config.clientId,
      this.config.clientSecret,
    );

    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ["https://graph.microsoft.com/.default"],
    });

    this.graphClient = Client.initWithMiddleware({ authProvider });
    return this.graphClient;
  }

  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      logger.warn(
        "[OutlookEmailProvider] Provider not fully configured, skipping initialization",
      );
      return;
    }

    logger.info(
      { mailbox: this.config.mailboxAddress },
      "[OutlookEmailProvider] Initializing provider",
    );

    // Note: Webhook subscription is created separately via the webhook route
    // when the backend receives the first request. This allows the webhook URL
    // to be determined at runtime.

    try {
      // Verify we can authenticate and access the mailbox
      const client = this.getGraphClient();
      await client
        .api(`/users/${this.config.mailboxAddress}/messages`)
        .top(1)
        .get();

      logger.info(
        { mailbox: this.config.mailboxAddress },
        "[OutlookEmailProvider] Successfully connected to mailbox",
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          mailbox: this.config.mailboxAddress,
        },
        "[OutlookEmailProvider] Failed to connect to mailbox",
      );
      throw error;
    }
  }

  getEmailDomain(): string {
    if (this.config.emailDomain) {
      return this.config.emailDomain;
    }

    // Extract domain from mailbox address
    const atIndex = this.config.mailboxAddress.indexOf("@");
    if (atIndex === -1) {
      throw new Error("Invalid mailbox address format");
    }
    return this.config.mailboxAddress.substring(atIndex + 1);
  }

  generateEmailAddress(promptId: string): string {
    // Use plus-addressing: user+promptId@domain.com
    // This routes all emails to the same mailbox while preserving the promptId
    const mailbox = this.config.mailboxAddress;
    const atIndex = mailbox.indexOf("@");

    if (atIndex === -1) {
      throw new Error("Invalid mailbox address format");
    }

    const localPart = mailbox.substring(0, atIndex);
    const domain = this.getEmailDomain();

    // Encode promptId to ensure it's email-safe
    const encodedPromptId = promptId.replace(/-/g, "");

    return `${localPart}+agent-${encodedPromptId}@${domain}`;
  }

  /**
   * Extract promptId from an agent email address
   */
  extractPromptIdFromEmail(emailAddress: string): string | null {
    // Match pattern: localPart+agent-{promptId}@domain
    const match = emailAddress.match(/\+agent-([a-f0-9]+)@/i);
    if (!match) {
      return null;
    }

    // Convert back to UUID format
    const raw = match[1];
    if (raw.length !== 32) {
      return null;
    }

    // Reconstruct UUID: 8-4-4-4-12
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  }

  handleValidationChallenge(payload: unknown): string | null {
    // Microsoft Graph sends a validation token that needs to be echoed back
    if (
      typeof payload === "object" &&
      payload !== null &&
      "validationToken" in payload
    ) {
      const token = (payload as { validationToken: string }).validationToken;
      logger.info("[OutlookEmailProvider] Responding to validation challenge");
      return token;
    }
    return null;
  }

  async validateWebhookRequest(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    // Microsoft Graph uses client state for validation
    // The client state is set when creating the subscription
    if (typeof payload === "object" && payload !== null && "value" in payload) {
      const notifications = (payload as { value: unknown[] }).value;
      if (Array.isArray(notifications) && notifications.length > 0) {
        const notification = notifications[0] as {
          clientState?: string;
        };

        // Verify client state matches our expected value
        // In production, this should be a cryptographically secure random string
        // stored during subscription creation
        if (notification.clientState === this.getClientState()) {
          return true;
        }
      }
    }

    logger.warn(
      { headers },
      "[OutlookEmailProvider] Invalid webhook request - client state mismatch",
    );
    return false;
  }

  private getClientState(): string {
    // In production, this should be stored securely when the subscription is created
    // For now, derive from the configuration
    return `archestra-${this.config.clientId.substring(0, 8)}`;
  }

  async parseWebhookNotification(
    payload: unknown,
    _headers: Record<string, string | string[] | undefined>,
  ): Promise<IncomingEmail[] | null> {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("value" in payload)
    ) {
      return null;
    }

    const notifications = (payload as { value: unknown[] }).value;
    if (!Array.isArray(notifications) || notifications.length === 0) {
      return null;
    }

    const emails: IncomingEmail[] = [];
    const client = this.getGraphClient();

    for (const notification of notifications) {
      const notif = notification as {
        resource?: string;
        resourceData?: {
          id?: string;
        };
        changeType?: string;
      };

      // Only process new message notifications
      if (notif.changeType !== "created") {
        continue;
      }

      const messageId = notif.resourceData?.id;
      if (!messageId) {
        continue;
      }

      try {
        // Fetch the full message
        const message = await client
          .api(`/users/${this.config.mailboxAddress}/messages/${messageId}`)
          .select(
            "id,subject,body,bodyPreview,from,toRecipients,receivedDateTime",
          )
          .get();

        // Find the agent email address from recipients
        const toRecipients = message.toRecipients || [];
        let agentEmailAddress: string | null = null;

        for (const recipient of toRecipients) {
          const email = recipient.emailAddress?.address;
          if (email && this.extractPromptIdFromEmail(email)) {
            agentEmailAddress = email;
            break;
          }
        }

        if (!agentEmailAddress) {
          logger.debug(
            { messageId, recipients: toRecipients },
            "[OutlookEmailProvider] No agent email address found in recipients",
          );
          continue;
        }

        // Extract plain text body
        let body = "";
        if (message.body?.contentType === "text") {
          body = message.body.content || "";
        } else if (message.body?.content) {
          // HTML body - use bodyPreview for plain text
          body = message.bodyPreview || this.stripHtml(message.body.content);
        }

        emails.push({
          messageId: message.id,
          toAddress: agentEmailAddress,
          fromAddress: message.from?.emailAddress?.address || "unknown",
          subject: message.subject || "",
          body,
          htmlBody:
            message.body?.contentType === "html"
              ? message.body.content
              : undefined,
          receivedAt: new Date(message.receivedDateTime),
          metadata: {
            provider: this.providerId,
            originalResource: notif.resource,
          },
        });
      } catch (error) {
        logger.error(
          {
            messageId,
            error: error instanceof Error ? error.message : String(error),
          },
          "[OutlookEmailProvider] Failed to fetch message",
        );
      }
    }

    return emails.length > 0 ? emails : null;
  }

  /**
   * Create a webhook subscription for new emails
   */
  async createSubscription(webhookUrl: string): Promise<string> {
    const client = this.getGraphClient();

    // Subscription expires after 3 days (maximum for mail resources)
    const expirationDateTime = new Date();
    expirationDateTime.setDate(expirationDateTime.getDate() + 3);

    try {
      const subscription = await client.api("/subscriptions").post({
        changeType: "created",
        notificationUrl: webhookUrl,
        resource: `/users/${this.config.mailboxAddress}/mailFolders/inbox/messages`,
        expirationDateTime: expirationDateTime.toISOString(),
        clientState: this.getClientState(),
      });

      this.subscriptionId = subscription.id;

      logger.info(
        {
          subscriptionId: subscription.id,
          expiresAt: subscription.expirationDateTime,
          webhookUrl,
        },
        "[OutlookEmailProvider] Created webhook subscription",
      );

      return subscription.id;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          webhookUrl,
        },
        "[OutlookEmailProvider] Failed to create subscription",
      );
      throw error;
    }
  }

  /**
   * Renew an existing subscription
   */
  async renewSubscription(subscriptionId: string): Promise<void> {
    const client = this.getGraphClient();

    const expirationDateTime = new Date();
    expirationDateTime.setDate(expirationDateTime.getDate() + 3);

    try {
      await client.api(`/subscriptions/${subscriptionId}`).patch({
        expirationDateTime: expirationDateTime.toISOString(),
      });

      logger.info(
        {
          subscriptionId,
          newExpiration: expirationDateTime.toISOString(),
        },
        "[OutlookEmailProvider] Renewed subscription",
      );
    } catch (error) {
      logger.error(
        {
          subscriptionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "[OutlookEmailProvider] Failed to renew subscription",
      );
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    if (this.subscriptionId) {
      try {
        const client = this.getGraphClient();
        await client.api(`/subscriptions/${this.subscriptionId}`).delete();

        logger.info(
          { subscriptionId: this.subscriptionId },
          "[OutlookEmailProvider] Deleted subscription",
        );
      } catch (error) {
        logger.warn(
          {
            subscriptionId: this.subscriptionId,
            error: error instanceof Error ? error.message : String(error),
          },
          "[OutlookEmailProvider] Failed to delete subscription on cleanup",
        );
      }
    }

    this.graphClient = null;
    this.subscriptionId = null;
  }

  /**
   * Simple HTML tag stripper for fallback plain text extraction
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}
