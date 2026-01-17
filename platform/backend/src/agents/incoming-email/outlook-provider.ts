import crypto from "node:crypto";
import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import logger from "@/logging";
import IncomingEmailSubscriptionModel from "@/models/incoming-email-subscription";
import type {
  AgentIncomingEmailProvider,
  EmailProviderConfig,
  EmailReplyOptions,
  IncomingEmail,
  SubscriptionInfo,
} from "@/types";
import { DEFAULT_AGENT_EMAIL_NAME } from "./constants";

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
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(
      12,
      16,
    )}-${raw.slice(16, 20)}-${raw.slice(20)}`;
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
    _headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    // Microsoft Graph uses client state for validation
    // The client state is set when creating the subscription and stored in DB
    if (typeof payload === "object" && payload !== null && "value" in payload) {
      const notifications = (payload as { value: unknown[] }).value;
      if (Array.isArray(notifications) && notifications.length > 0) {
        const notification = notifications[0] as {
          clientState?: string;
        };

        if (!notification.clientState) {
          logger.warn(
            "[OutlookEmailProvider] Webhook request missing clientState",
          );
          return false;
        }

        // Fetch the active subscription from database to get the expected clientState
        const activeSubscription =
          await IncomingEmailSubscriptionModel.getActiveSubscription();
        if (!activeSubscription) {
          logger.warn(
            "[OutlookEmailProvider] No active subscription found for validation",
          );
          return false;
        }

        // Use constant-time comparison to prevent timing attacks
        const expectedBuffer = Buffer.from(activeSubscription.clientState);
        const receivedBuffer = Buffer.from(notification.clientState);

        if (
          expectedBuffer.length === receivedBuffer.length &&
          crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
        ) {
          return true;
        }

        logger.warn(
          "[OutlookEmailProvider] Invalid webhook request - client state mismatch",
        );
        return false;
      }
    }

    logger.warn(
      "[OutlookEmailProvider] Invalid webhook request - unexpected payload format",
    );
    return false;
  }

  /**
   * Generate a cryptographically secure client state for webhook validation
   */
  private generateClientState(): string {
    return crypto.randomBytes(32).toString("base64url");
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
        // Fetch the full message including conversationId for thread context
        const message = await client
          .api(`/users/${this.config.mailboxAddress}/messages/${messageId}`)
          .select(
            "id,conversationId,subject,body,bodyPreview,from,toRecipients,receivedDateTime",
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
        // For email threads, we need the full body content including quoted replies
        // bodyPreview is limited (~255 chars) and truncates conversation history
        let body = "";
        if (message.body?.contentType === "text") {
          body = message.body.content || "";
        } else if (message.body?.content) {
          // HTML body - convert to plain text to preserve conversation thread
          body = this.stripHtml(message.body.content);
        }

        emails.push({
          messageId: message.id,
          conversationId: message.conversationId,
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
   * @returns SubscriptionInfo with database record and expiration details
   */
  async createSubscription(webhookUrl: string): Promise<SubscriptionInfo> {
    const client = this.getGraphClient();

    // Generate cryptographically secure client state for webhook validation
    const clientState = this.generateClientState();

    // Subscription expires after 3 days (maximum for mail resources)
    const expirationDateTime = new Date();
    expirationDateTime.setDate(expirationDateTime.getDate() + 3);

    try {
      const subscription = await client.api("/subscriptions").post({
        changeType: "created",
        notificationUrl: webhookUrl,
        resource: `/users/${this.config.mailboxAddress}/mailFolders/inbox/messages`,
        expirationDateTime: expirationDateTime.toISOString(),
        clientState,
      });

      this.subscriptionId = subscription.id;

      // Persist subscription to database with the clientState for later validation
      const expiresAt = new Date(subscription.expirationDateTime);
      const dbRecord = await IncomingEmailSubscriptionModel.create({
        subscriptionId: subscription.id,
        provider: this.providerId,
        webhookUrl,
        clientState,
        expiresAt,
      });

      logger.info(
        {
          subscriptionId: subscription.id,
          dbRecordId: dbRecord.id,
          expiresAt: subscription.expirationDateTime,
          webhookUrl,
        },
        "[OutlookEmailProvider] Created webhook subscription",
      );

      return {
        id: dbRecord.id,
        subscriptionId: subscription.id,
        provider: this.providerId,
        webhookUrl,
        clientState,
        expiresAt,
        isActive: true,
      };
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
   * @returns The new expiration date
   */
  async renewSubscription(subscriptionId: string): Promise<Date> {
    const client = this.getGraphClient();

    const expirationDateTime = new Date();
    expirationDateTime.setDate(expirationDateTime.getDate() + 3);

    try {
      await client.api(`/subscriptions/${subscriptionId}`).patch({
        expirationDateTime: expirationDateTime.toISOString(),
      });

      // Update expiration in database
      const dbRecord =
        await IncomingEmailSubscriptionModel.findBySubscriptionId(
          subscriptionId,
        );
      if (dbRecord) {
        await IncomingEmailSubscriptionModel.updateExpiry({
          id: dbRecord.id,
          expiresAt: expirationDateTime,
        });
      }

      logger.info(
        {
          subscriptionId,
          newExpiration: expirationDateTime.toISOString(),
        },
        "[OutlookEmailProvider] Renewed subscription",
      );

      return expirationDateTime;
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

  /**
   * Get the current subscription status from database
   */
  async getSubscriptionStatus(): Promise<SubscriptionInfo | null> {
    const subscription = await IncomingEmailSubscriptionModel.getMostRecent();
    if (!subscription) {
      return null;
    }

    const now = new Date();
    return {
      id: subscription.id,
      subscriptionId: subscription.subscriptionId,
      provider: subscription.provider,
      webhookUrl: subscription.webhookUrl,
      clientState: subscription.clientState,
      expiresAt: subscription.expiresAt,
      isActive: subscription.expiresAt > now,
    };
  }

  /**
   * List all subscriptions from Microsoft Graph API
   * Useful for debugging and cleaning up stale subscriptions
   */
  async listGraphSubscriptions(): Promise<
    Array<{
      id: string;
      resource: string;
      notificationUrl: string;
      expirationDateTime: string;
      clientState: string | null;
    }>
  > {
    const client = this.getGraphClient();

    try {
      const response = await client.api("/subscriptions").get();
      const subscriptions = response.value || [];

      logger.info(
        { count: subscriptions.length },
        "[OutlookEmailProvider] Listed subscriptions from Graph API",
      );

      return subscriptions.map(
        (sub: {
          id: string;
          resource: string;
          notificationUrl: string;
          expirationDateTime: string;
          clientState?: string;
        }) => ({
          id: sub.id,
          resource: sub.resource,
          notificationUrl: sub.notificationUrl,
          expirationDateTime: sub.expirationDateTime,
          clientState: sub.clientState || null,
        }),
      );
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "[OutlookEmailProvider] Failed to list subscriptions from Graph API",
      );
      throw error;
    }
  }

  /**
   * Delete all subscriptions from Microsoft Graph API
   * Useful for cleaning up stale subscriptions during development
   */
  async deleteAllGraphSubscriptions(): Promise<number> {
    const subscriptions = await this.listGraphSubscriptions();
    let deleted = 0;

    for (const sub of subscriptions) {
      try {
        await this.deleteSubscription(sub.id);
        deleted++;
      } catch (error) {
        logger.warn(
          {
            subscriptionId: sub.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "[OutlookEmailProvider] Failed to delete subscription",
        );
      }
    }

    logger.info(
      { deleted, total: subscriptions.length },
      "[OutlookEmailProvider] Deleted subscriptions from Graph API",
    );

    return deleted;
  }

  /**
   * Delete a subscription from Graph API and database
   */
  async deleteSubscription(subscriptionId: string): Promise<void> {
    const client = this.getGraphClient();

    try {
      await client.api(`/subscriptions/${subscriptionId}`).delete();
      logger.info(
        { subscriptionId },
        "[OutlookEmailProvider] Deleted subscription from Graph API",
      );
    } catch (error) {
      logger.warn(
        {
          subscriptionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "[OutlookEmailProvider] Failed to delete subscription from Graph API (may already be expired)",
      );
    }

    // Always remove from database
    await IncomingEmailSubscriptionModel.deleteBySubscriptionId(subscriptionId);
    logger.info(
      { subscriptionId },
      "[OutlookEmailProvider] Removed subscription from database",
    );

    if (this.subscriptionId === subscriptionId) {
      this.subscriptionId = null;
    }
  }

  /**
   * Send a reply to an incoming email
   * Uses Microsoft Graph API to send a reply that maintains the email thread
   *
   * **Threading**: The Graph API `/reply` endpoint automatically maintains proper
   * email threading by setting conversationId, In-Reply-To, and References headers.
   * This ensures replies appear in the same thread regardless of the `from` address.
   *
   * **Microsoft Graph API Limitation**: The Graph API does not support sending from
   * dynamically generated plus-addressed aliases (e.g., mailbox+agent-xxx@domain.com)
   * even with "Send As" permission configured in Exchange. The `from` address must be
   * a primary email or explicitly configured proxy address on the mailbox.
   *
   * **Fallback behavior** (default for plus-addressed agent emails):
   * - Reply is sent from the mailbox's primary address
   * - `replyTo` is set to the agent's plus-addressed email
   * - Recipients can reply directly to the agent using "Reply" in their email client
   * - Threading is preserved via the Graph API's reply mechanism
   */
  async sendReply(options: EmailReplyOptions): Promise<string> {
    const { originalEmail, body, htmlBody, agentName } = options;
    const client = this.getGraphClient();
    const displayName = agentName || DEFAULT_AGENT_EMAIL_NAME;

    logger.info(
      {
        originalMessageId: originalEmail.messageId,
        toAddress: originalEmail.fromAddress,
        subject: originalEmail.subject,
        agentName: displayName,
      },
      "[OutlookEmailProvider] Sending reply to email",
    );

    // Build the reply message body
    const replyBody: {
      contentType: "Text" | "HTML";
      content: string;
    } = htmlBody
      ? { contentType: "HTML", content: htmlBody }
      : { contentType: "Text", content: body };

    // Use the agent's email address (the toAddress from the original email)
    const agentEmailAddress = originalEmail.toAddress;

    // Try to send with 'from' set to agent's email address
    // Note: This will likely fail for plus-addressed aliases due to Graph API limitations
    // (see JSDoc above). We try anyway in case the address is an explicit alias.
    try {
      await client
        .api(
          `/users/${this.config.mailboxAddress}/messages/${originalEmail.messageId}/reply`,
        )
        .post({
          message: {
            from: {
              emailAddress: {
                address: agentEmailAddress,
                name: displayName,
              },
            },
            body: replyBody,
          },
        });

      // Graph API reply endpoint doesn't return the new message ID directly
      // Generate a tracking ID for logging purposes
      const replyTrackingId = `reply-${
        originalEmail.messageId
      }-${crypto.randomUUID()}`;

      logger.info(
        {
          originalMessageId: originalEmail.messageId,
          replyTrackingId,
          recipient: originalEmail.fromAddress,
          fromAddress: agentEmailAddress,
        },
        "[OutlookEmailProvider] Reply sent with agent as sender",
      );

      return replyTrackingId;
    } catch (sendAsError) {
      // Check if this is a "Send As" permission error
      const errorMessage =
        sendAsError instanceof Error
          ? sendAsError.message
          : String(sendAsError);
      const isSendAsError =
        errorMessage.includes("send mail on behalf of") ||
        errorMessage.includes("SendAs");

      if (!isSendAsError) {
        // Re-throw non-permission errors
        logger.error(
          {
            originalMessageId: originalEmail.messageId,
            recipient: originalEmail.fromAddress,
            error: errorMessage,
          },
          "[OutlookEmailProvider] Failed to send reply",
        );
        throw sendAsError;
      }

      // Fallback: Graph API rejected the plus-addressed 'from' address (expected behavior)
      // Send from mailbox's primary address but set replyTo to agent's email
      // Threading is still maintained via the Graph API's reply mechanism
      logger.info(
        {
          originalMessageId: originalEmail.messageId,
          agentEmailAddress,
        },
        "[OutlookEmailProvider] Using replyTo for plus-addressed agent email (Graph API limitation)",
      );

      await client
        .api(
          `/users/${this.config.mailboxAddress}/messages/${originalEmail.messageId}/reply`,
        )
        .post({
          message: {
            replyTo: [
              {
                emailAddress: {
                  address: agentEmailAddress,
                  name: displayName,
                },
              },
            ],
            body: replyBody,
          },
        });

      const replyTrackingId = `reply-${
        originalEmail.messageId
      }-${crypto.randomUUID()}`;

      logger.info(
        {
          originalMessageId: originalEmail.messageId,
          replyTrackingId,
          recipient: originalEmail.fromAddress,
          replyTo: agentEmailAddress,
        },
        "[OutlookEmailProvider] Reply sent with replyTo fallback",
      );

      return replyTrackingId;
    }
  }

  /**
   * Get conversation history for an email thread
   * Fetches all messages in the conversation except the current one
   * @param conversationId - The conversation ID from the email
   * @param currentMessageId - The current message ID to exclude from history
   * @returns Array of previous messages in the conversation, oldest first
   */
  async getConversationHistory(
    conversationId: string,
    currentMessageId: string,
  ): Promise<
    Array<{
      messageId: string;
      fromAddress: string;
      fromName?: string;
      body: string;
      receivedAt: Date;
      isAgentMessage: boolean;
    }>
  > {
    const client = this.getGraphClient();

    try {
      // Escape single quotes in conversationId for OData filter
      // The conversationId may contain special characters that need escaping
      const escapedConversationId = conversationId.replace(/'/g, "''");

      // Fetch all messages in the conversation
      // Note: Microsoft Graph API doesn't allow combining $filter on conversationId
      // with $orderby on receivedDateTime, so we fetch without ordering and sort client-side
      const response = await client
        .api(`/users/${this.config.mailboxAddress}/messages`)
        .filter(`conversationId eq '${escapedConversationId}'`)
        .select("id,from,body,receivedDateTime,sender")
        .top(50) // Limit to last 50 messages to avoid excessive context
        .get();

      const messages = response.value || [];
      const history: Array<{
        messageId: string;
        fromAddress: string;
        fromName?: string;
        body: string;
        receivedAt: Date;
        isAgentMessage: boolean;
      }> = [];

      for (const message of messages) {
        // Skip the current message
        if (message.id === currentMessageId) {
          continue;
        }

        const fromAddress = message.from?.emailAddress?.address || "unknown";
        const fromName = message.from?.emailAddress?.name;

        // Determine if this message was sent by the agent (from the mailbox)
        const isAgentMessage =
          fromAddress.toLowerCase() ===
          this.config.mailboxAddress.toLowerCase();

        // Extract plain text body
        let body = "";
        if (message.body?.contentType === "text") {
          body = message.body.content || "";
        } else if (message.body?.content) {
          body = this.stripHtml(message.body.content);
        }

        history.push({
          messageId: message.id,
          fromAddress,
          fromName,
          body,
          receivedAt: new Date(message.receivedDateTime),
          isAgentMessage,
        });
      }

      // Sort by receivedAt ascending (oldest first) since we couldn't use $orderby with $filter
      history.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());

      logger.debug(
        {
          conversationId,
          currentMessageId,
          historyCount: history.length,
        },
        "[OutlookEmailProvider] Fetched conversation history",
      );

      return history;
    } catch (error) {
      // Log detailed error information for debugging
      const errorDetails =
        error instanceof Error
          ? {
              message: error.message,
              name: error.name,
              stack: error.stack?.split("\n").slice(0, 3).join("\n"),
            }
          : { raw: String(error) };

      logger.error(
        {
          conversationId,
          currentMessageId,
          errorDetails,
        },
        "[OutlookEmailProvider] Failed to fetch conversation history",
      );
      // Return empty history on error - allow processing to continue
      return [];
    }
  }

  async cleanup(): Promise<void> {
    if (this.subscriptionId) {
      // Use deleteSubscription which handles both Graph API and database cleanup
      await this.deleteSubscription(this.subscriptionId);
    }

    this.graphClient = null;
    this.subscriptionId = null;
  }

  /**
   * Convert HTML to plain text while preserving conversation structure
   * Handles email-specific HTML elements like blockquotes for email threads
   */
  private stripHtml(html: string): string {
    let result = html;

    // Handle horizontal rules FIRST (often used as reply separators)
    // Must be before tag stripping since <hr> may have attributes
    result = result.replace(/<hr[^>]*\/?>/gi, "\n---\n");

    // Replace common block elements with newlines
    result = result.replace(/<br\s*\/?>/gi, "\n");
    result = result.replace(/<\/p>/gi, "\n\n");
    result = result.replace(/<\/div>/gi, "\n");
    result = result.replace(/<\/h[1-6]>/gi, "\n\n");
    result = result.replace(/<\/li>/gi, "\n");

    // Handle blockquotes (common in email replies) with ">" prefix
    // Process iteratively to handle nested blockquotes from outside-in
    let previousResult = "";
    while (previousResult !== result) {
      previousResult = result;
      result = result.replace(
        /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
        (_match, content) => {
          // Strip tags from content but don't process blockquotes yet
          const strippedContent = content
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n")
            .replace(/<\/div>/gi, "\n")
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/[ \t]+/g, " ")
            .trim();
          const lines = strippedContent.split("\n");
          return `\n${lines
            .map((line: string) => `> ${line.trim()}`)
            .join("\n")}\n`;
        },
      );
    }

    // Strip remaining tags
    result = result.replace(/<[^>]*>/g, " ");

    // Decode common HTML entities
    // Note: &amp; must be decoded LAST to prevent double-unescaping
    // (e.g., &amp;lt; should become &lt; not <)
    result = result.replace(/&nbsp;/gi, " ");
    result = result.replace(/&lt;/gi, "<");
    result = result.replace(/&gt;/gi, ">");
    result = result.replace(/&quot;/gi, '"');
    result = result.replace(/&#39;/gi, "'");
    result = result.replace(/&amp;/gi, "&");

    // Clean up whitespace while preserving intentional line breaks
    result = result.replace(/[ \t]+/g, " ");
    result = result.replace(/\n +/g, "\n");
    result = result.replace(/ +\n/g, "\n");
    result = result.replace(/\n{3,}/g, "\n\n");

    return result.trim();
  }
}
