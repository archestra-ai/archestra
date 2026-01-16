import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";
import {
  type EmailProviderType,
  EmailProviderTypeSchema,
} from "@/types/email-provider-type";

// Re-export for convenience
export { type EmailProviderType, EmailProviderTypeSchema };

/**
 * Database schemas for processed emails (deduplication)
 */
export const SelectProcessedEmailSchema = createSelectSchema(
  schema.processedEmailsTable,
);
export const InsertProcessedEmailSchema = createInsertSchema(
  schema.processedEmailsTable,
).omit({
  id: true,
  processedAt: true,
});

export type SelectProcessedEmail = z.infer<typeof SelectProcessedEmailSchema>;
export type InsertProcessedEmail = z.infer<typeof InsertProcessedEmailSchema>;

/**
 * Database schemas for incoming email subscriptions
 */
export const SelectIncomingEmailSubscriptionSchema = createSelectSchema(
  schema.incomingEmailSubscriptionsTable,
  {
    provider: EmailProviderTypeSchema,
  },
);
export const InsertIncomingEmailSubscriptionSchema = createInsertSchema(
  schema.incomingEmailSubscriptionsTable,
  {
    provider: EmailProviderTypeSchema,
  },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const UpdateIncomingEmailSubscriptionSchema = createUpdateSchema(
  schema.incomingEmailSubscriptionsTable,
  {
    provider: EmailProviderTypeSchema,
  },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type SelectIncomingEmailSubscription = z.infer<
  typeof SelectIncomingEmailSubscriptionSchema
>;
export type InsertIncomingEmailSubscription = z.infer<
  typeof InsertIncomingEmailSubscriptionSchema
>;
export type UpdateIncomingEmailSubscription = z.infer<
  typeof UpdateIncomingEmailSubscriptionSchema
>;

/**
 * Information about the current webhook subscription
 * Same as database record but with computed isActive field
 */
export type SubscriptionInfo = Omit<
  SelectIncomingEmailSubscription,
  "createdAt" | "updatedAt"
> & {
  /** Whether the subscription is currently active (not expired) */
  isActive: boolean;
};

/**
 * Represents an incoming email that will invoke an agent
 */
export interface IncomingEmail {
  /** The unique message ID from the email provider */
  messageId: string;
  /** The conversation ID for threading (used to fetch conversation history) */
  conversationId?: string;
  /** The email address that received the email (agent's email) */
  toAddress: string;
  /** The sender's email address */
  fromAddress: string;
  /** The email subject */
  subject: string;
  /** The plain text body of the email (used as the agent's first message) */
  body: string;
  /** Optional HTML body */
  htmlBody?: string;
  /** When the email was received */
  receivedAt: Date;
  /** Any additional metadata from the provider */
  metadata?: Record<string, unknown>;
}

/**
 * A message in an email conversation thread
 */
export interface ConversationMessage {
  /** The unique message ID */
  messageId: string;
  /** The sender's email address */
  fromAddress: string;
  /** The sender's display name */
  fromName?: string;
  /** The plain text body of the message */
  body: string;
  /** When the message was received */
  receivedAt: Date;
  /** Whether this message was sent by the agent (vs the user) */
  isAgentMessage: boolean;
}

/**
 * Options for sending an email reply
 */
export interface EmailReplyOptions {
  /** The original email to reply to */
  originalEmail: IncomingEmail;
  /** The reply message body (plain text) */
  body: string;
  /** Optional HTML body for rich formatting */
  htmlBody?: string;
  /** The name of the agent sending the reply (for display in email client) */
  agentName?: string;
}

/**
 * Result of processing an incoming email
 */
export interface EmailProcessingResult {
  success: boolean;
  /** The agent execution result (if successful) */
  agentResponse?: string;
  /** Error message (if failed) */
  error?: string;
  /** The message ID generated for this invocation */
  messageId?: string;
}

/**
 * Configuration for agent email addresses
 */
export interface AgentEmailConfig {
  /** The prompt ID this email address is associated with */
  promptId: string;
  /** The generated email address for this agent */
  emailAddress: string;
  /** Whether this email address is enabled */
  enabled: boolean;
}

/**
 * Interface for incoming email providers (Outlook, Gmail, etc.)
 *
 * Implementations should:
 * 1. Register webhooks/subscriptions for incoming emails
 * 2. Parse incoming email notifications
 * 3. Generate unique email addresses for agents
 * 4. Handle email retrieval when needed
 */
export interface AgentIncomingEmailProvider {
  /** Provider identifier (e.g., 'outlook', 'gmail') */
  readonly providerId: string;

  /** Display name for the UI */
  readonly displayName: string;

  /**
   * Check if the provider is properly configured
   */
  isConfigured(): boolean;

  /**
   * Initialize the provider (setup webhooks, subscriptions, etc.)
   * Called once when the server starts if the provider is configured
   */
  initialize(): Promise<void>;

  /**
   * Generate a unique email address for an agent (prompt)
   * @param promptId - The prompt ID to generate an email for
   * @returns The email address that will invoke this agent
   */
  generateEmailAddress(promptId: string): string;

  /**
   * Parse the domain used for agent email addresses
   * @returns The domain portion of agent email addresses
   */
  getEmailDomain(): string;

  /**
   * Parse an incoming webhook notification from the email provider
   * @param payload - The raw webhook payload
   * @param headers - HTTP headers from the webhook request
   * @returns Parsed email(s) or null if not a valid notification
   */
  parseWebhookNotification(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<IncomingEmail[] | null>;

  /**
   * Validate a webhook request (signature verification, etc.)
   * @param payload - The raw webhook payload
   * @param headers - HTTP headers from the webhook request
   * @returns true if the request is valid
   */
  validateWebhookRequest(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean>;

  /**
   * Handle webhook validation challenge (for initial setup)
   * @param payload - The challenge payload
   * @returns Response to send back, or null if not a validation request
   */
  handleValidationChallenge(payload: unknown): string | null;

  /**
   * Clean up resources (unsubscribe webhooks, etc.)
   * Called on graceful shutdown
   */
  cleanup(): Promise<void>;

  /**
   * Send a reply to an incoming email
   * @param options - The reply options including original email and response body
   * @returns The message ID of the sent reply
   */
  sendReply(options: EmailReplyOptions): Promise<string>;

  /**
   * Get conversation history for an email thread
   * @param conversationId - The conversation ID from the email
   * @param currentMessageId - The current message ID to exclude from history
   * @returns Array of previous messages in the conversation, oldest first
   */
  getConversationHistory(
    conversationId: string,
    currentMessageId: string,
  ): Promise<ConversationMessage[]>;
}

/**
 * Email provider configuration from environment variables
 */
export interface EmailProviderConfig {
  provider: EmailProviderType | undefined;
  outlook?: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    /** The email address/mailbox to monitor for incoming emails */
    mailboxAddress: string;
    /**
     * The domain used for generating agent email addresses
     * If not set, extracts domain from mailboxAddress
     */
    emailDomain?: string;
    /**
     * Webhook URL for auto-setup on startup
     * If set, subscription will be created automatically during initialization
     */
    webhookUrl?: string;
  };
}
