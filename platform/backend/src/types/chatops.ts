import { z } from "zod";

/**
 * ChatOps provider types enum
 * Used for PG ENUM in database schema
 */
export const ChatOpsProviderTypeSchema = z.enum(["ms-teams", "slack"]);
export type ChatOpsProviderType = z.infer<typeof ChatOpsProviderTypeSchema>;

/**
 * Represents an incoming chat message from a chatops provider
 */
export interface IncomingChatMessage {
  /** Unique message ID from the provider */
  messageId: string;
  /** The channel where the message was sent */
  channelId: string;
  /** The workspace/team ID (e.g., Teams team ID) */
  workspaceId: string | null;
  /** Thread/conversation ID for fetching history */
  threadId?: string;
  /** The sender's ID in the provider's system */
  senderId: string;
  /** Pre-resolved sender email (from Bot Framework TeamsInfo, avoids Graph API call) */
  senderEmail?: string;
  /** The sender's display name */
  senderName: string;
  /** The message text (with bot mentions cleaned) */
  text: string;
  /** Raw message text before cleaning */
  rawText: string;
  /** When the message was sent */
  timestamp: Date;
  /** Whether this is a reply to a thread */
  isThreadReply: boolean;
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for sending a chat reply
 */
export interface ChatReplyOptions {
  /** The original message to reply to */
  originalMessage: IncomingChatMessage;
  /** The reply text */
  text: string;
  /** Optional: Reply in thread (if supported) */
  replyInThread?: boolean;
  /** Optional: Footer text to append */
  footer?: string;
  /** Provider-specific conversation reference for reply routing */
  conversationReference?: unknown;
}

/**
 * A message in a chat thread history
 */
export interface ChatThreadMessage {
  /** Unique message ID */
  messageId: string;
  /** The sender's ID */
  senderId: string;
  /** The sender's display name */
  senderName: string;
  /** The message text */
  text: string;
  /** When the message was sent */
  timestamp: Date;
  /** Whether this message was from the bot */
  isFromBot: boolean;
}

/**
 * Parameters for fetching thread history
 */
export interface ThreadHistoryParams {
  /** The channel ID */
  channelId: string;
  /** The workspace/team ID */
  workspaceId: string | null;
  /** The thread/conversation ID */
  threadId: string;
  /** Maximum number of messages to fetch */
  limit?: number;
  /** Exclude this message ID from results */
  excludeMessageId?: string;
}

/**
 * Result of processing a chatops message
 */
export interface ChatOpsProcessingResult {
  success: boolean;
  /** The agent response (if successful) */
  agentResponse?: string;
  /** Error message (if failed) */
  error?: string;
  /** The interaction ID for tracking */
  interactionId?: string;
}

/**
 * A channel discovered by a chatops provider.
 * Used to auto-populate channel bindings so admins can assign agents from the UI.
 */
export interface DiscoveredChannel {
  channelId: string;
  channelName: string | null;
  workspaceId: string;
  workspaceName: string | null;
}

/**
 * Interface for chatops providers (MS Teams, Slack, Discord, etc.)
 *
 * Implementations should:
 * 1. Handle webhook validation and JWT verification
 * 2. Parse incoming activities/events into IncomingChatMessage
 * 3. Send replies using provider-specific APIs
 * 4. Fetch thread history for conversation context
 * 5. Discover available channels for auto-populating bindings
 */
export interface ChatOpsProvider {
  /** Provider identifier */
  readonly providerId: ChatOpsProviderType;

  /** Display name for UI */
  readonly displayName: string;

  /**
   * Check if the provider is properly configured
   */
  isConfigured(): boolean;

  /**
   * Initialize the provider (setup adapters, clients, etc.)
   * Called once when the server starts if the provider is configured
   */
  initialize(): Promise<void>;

  /**
   * Clean up resources
   * Called on graceful shutdown
   */
  cleanup(): Promise<void>;

  /**
   * Validate a webhook request (signature/JWT verification)
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
  handleValidationChallenge(payload: unknown): unknown | null;

  /**
   * Parse a webhook notification into an IncomingChatMessage
   * @param payload - The raw webhook payload
   * @param headers - HTTP headers from the webhook request
   * @returns Parsed message or null if not a processable message
   */
  parseWebhookNotification(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<IncomingChatMessage | null>;

  /**
   * Send a reply to a chat message
   * @param options - Reply options including original message and response text
   * @returns The message ID of the sent reply
   */
  sendReply(options: ChatReplyOptions): Promise<string>;

  /**
   * Get thread/conversation history for context
   * @param params - Parameters including channel, thread ID, and limit
   * @returns Array of previous messages, oldest first
   */
  getThreadHistory(params: ThreadHistoryParams): Promise<ChatThreadMessage[]>;

  /**
   * Get user's email address from their provider-specific ID
   * Used for security validation to verify the user exists in Archestra
   * @param userId - The user's ID in the provider's system (e.g., AAD Object ID for MS Teams)
   * @returns The user's email address, or null if not available
   */
  getUserEmail(userId: string): Promise<string | null>;

  /**
   * Get a channel's display name from its provider-specific ID.
   * Used when creating early bindings for channels not yet in the discovery cache.
   * @param channelId - The channel ID in the provider's system
   * @returns The channel name, or null if not available
   */
  getChannelName(channelId: string): Promise<string | null>;

  /**
   * Parse an interactive payload (e.g. button click) into a structured selection.
   * Each provider implements its own payload parsing (Block Kit for Slack, Adaptive Card for MS Teams).
   * @param payload - The raw interactive payload from the provider
   * @returns Parsed selection or null if not a valid agent selection
   */
  parseInteractivePayload(payload: unknown): {
    agentId: string;
    channelId: string;
    workspaceId: string | null;
    threadTs?: string;
    userId: string;
    userName: string;
    responseUrl: string;
  } | null;

  /**
   * Send an agent selection card/message to a channel.
   * Each provider renders the card in its native format (Adaptive Card for MS Teams, Block Kit for Slack).
   * @param params.message - The incoming message that triggered the selection
   * @param params.agents - Available agents to choose from
   * @param params.isWelcome - Whether this is a first-time welcome (true) or a change-agent request (false)
   * @param params.providerContext - Provider-specific context (e.g., TurnContext for MS Teams)
   */
  sendAgentSelectionCard(params: {
    message: IncomingChatMessage;
    agents: { id: string; name: string }[];
    isWelcome: boolean;
    providerContext?: unknown;
  }): Promise<void>;

  /**
   * Get the workspace/team ID for this provider, if known without an incoming message.
   * Used for eager channel discovery on startup.
   * Returns null if the workspace ID can only be determined from incoming messages
   * (e.g., MS Teams requires a TurnContext to know which team).
   */
  getWorkspaceId(): string | null;

  /**
   * Get the workspace/team display name for this provider, if known.
   * Used to populate workspaceName on channel bindings (including DMs).
   */
  getWorkspaceName(): string | null;

  /**
   * Discover all channels in a workspace/team.
   * Used to auto-populate channel bindings so admins can assign agents from the UI.
   * @param context - Provider-specific context (e.g., TurnContext for MS Teams)
   * @returns Discovered channels, or null if context doesn't support discovery
   */
  discoverChannels(context: unknown): Promise<DiscoveredChannel[] | null>;
}

/**
 * Callback interface for socket-mode providers to delegate events
 * back to the ChatOpsManager without depending on it directly.
 */
export interface ChatOpsEventHandler {
  handleIncomingMessage(
    provider: ChatOpsProvider,
    body: unknown,
  ): Promise<void>;
  handleInteractiveSelection(
    provider: ChatOpsProvider,
    payload: unknown,
  ): Promise<void>;
  getAccessibleChatopsAgents(params: {
    senderEmail?: string;
  }): Promise<{ id: string; name: string }[]>;
}

/**
 * MS Teams specific configuration from environment variables
 */
export interface MSTeamsConfig {
  enabled: boolean;
  /** Azure Bot App ID */
  appId: string;
  /** Azure Bot App Secret (Client Secret) */
  appSecret: string;
  /** Optional Graph API configuration for thread history */
  graph?: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
  };
}
