import { randomUUID } from "node:crypto";
import { ClientSecretCredential } from "@azure/identity";
import { AzureIdentityAuthenticationProvider } from "@microsoft/kiota-authentication-azure";
import {
  createGraphServiceClient,
  GraphRequestAdapter,
  type GraphServiceClient,
} from "@microsoft/msgraph-sdk";
import type {
  ChatMessage,
  ChatMessageAttachment,
} from "@microsoft/msgraph-sdk/models";
import { resolveMSTeamsUserEmail } from "./ms-teams-user";
// Register the chats, teams, and users fluent API extensions
import "@microsoft/msgraph-sdk-chats";
import "@microsoft/msgraph-sdk-teams";
import "@microsoft/msgraph-sdk-users";
import {
  Activity,
  ActivityTypes,
  type ConversationReference,
} from "@microsoft/agents-activity";
import {
  type AuthConfiguration,
  authorizeJWT,
  CloudAdapter,
  type Request,
  TurnContext,
  type WebResponse,
} from "@microsoft/agents-hosting";
import type { A2AAttachment } from "@/agents/a2a-executor";
import { msTeamsDirectory } from "@/agents/chatops/ms-teams-directory";

import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { CacheKey, cacheManager, LRUCacheManager } from "@/cache-manager";
import logger from "@/logging";
import { ChatOpsChannelBindingModel } from "@/models";
import type {
  AddApprovalRequestFormOptions,
  ChatOpsApprovalDecision,
  ChatOpsEventHandler,
  ChatOpsProvider,
  ChatOpsProviderType,
  ChatReplyOptions,
  ChatThreadMessage,
  ChatThreadMessageFile,
  DiscoveredChannel,
  IncomingChatMessage,
  MsTeamsDbConfig,
  SkippedAttachment,
  ThreadFileOutcome,
  ThreadHistoryParams,
  UpdateApprovalRequestOptions,
} from "@/types";
import { detectImageType } from "@/utils/detect-image-type";
import { stripHtmlTags } from "@/utils/strip-html";
import { isUuid } from "@/utils/uuid";
import { isMuteReaction } from "./channel-activation";
import {
  CHATOPS_ATTACHMENT_LIMITS,
  CHATOPS_TEAM_CACHE,
  CHATOPS_THREAD_HISTORY,
} from "./constants";
import {
  errorMessage,
  formatApprovalReviewText,
  stripDuplicateAgentFooter,
} from "./utils";

/**
 * MS Teams provider using Microsoft 365 Agents SDK.
 *
 * Security:
 * - JWT validation runs before the adapter processes any activity
 * - Supports single-tenant and multi-tenant Azure Bot configurations
 */
class MSTeamsProvider implements ChatOpsProvider {
  readonly providerId: ChatOpsProviderType = "ms-teams";
  readonly displayName = "Microsoft Teams";

  private adapter: CloudAdapter | null = null;
  private authorize: ReturnType<typeof authorizeJWT> | null = null;
  private graphClient: GraphServiceClient | null = null;
  private graphCredential: ClientSecretCredential | null = null;
  private eventHandler: ChatOpsEventHandler | null = null;
  private config: MsTeamsDbConfig;

  constructor(msTeamsConfig: MsTeamsDbConfig) {
    this.config = msTeamsConfig;
  }

  setEventHandler(handler: ChatOpsEventHandler): void {
    this.eventHandler = handler;
  }

  isConfigured(): boolean {
    return (
      this.config.enabled &&
      Boolean(this.config.appId) &&
      Boolean(this.config.appSecret)
    );
  }

  /**
   * Channel threads read their history from Graph. 1:1 and group chats have
   * no reply threads, so each chat is one server-side session instead.
   */
  usesServerSideSessionsFor(message: IncomingChatMessage): boolean {
    const type = message.metadata?.conversationType;
    return type === "personal" || type === "groupChat";
  }

  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info("[MSTeamsProvider] Not configured, skipping initialization");
      return;
    }

    const { appId, appSecret, tenantId } = this.config;
    const graph = {
      tenantId: this.config.graphTenantId,
      clientId: this.config.graphClientId,
      clientSecret: this.config.graphClientSecret,
    };

    const connection: AuthConfiguration = {
      clientId: appId,
      clientSecret: appSecret,
      // Legacy multi-tenant bots acquire connector tokens from this tenant.
      tenantId: tenantId || "botframework.com",
      validateIssuer: true,
    };
    const auth: AuthConfiguration = {
      ...connection,
      connections: new Map([["teams", connection]]),
      connectionsMap: [{ serviceUrl: "*", connection: "teams" }],
    };
    this.authorize = authorizeJWT(auth);
    this.adapter = new CloudAdapter(auth, undefined, undefined, {
      validateServiceUrl: true,
    });
    this.adapter.onTurnError = async (_context, error) => {
      logger.error(
        { error: errorMessage(error) },
        "[MSTeamsProvider] Agents SDK turn error",
      );
    };

    logger.info(
      { tenantMode: tenantId ? "single-tenant" : "multi-tenant" },
      "[MSTeamsProvider] Agents SDK adapter initialized",
    );

    // Initialize Graph client if configured
    if (graph?.tenantId && graph?.clientId && graph?.clientSecret) {
      const credential = new ClientSecretCredential(
        graph.tenantId,
        graph.clientId,
        graph.clientSecret,
      );
      const authProvider = new AzureIdentityAuthenticationProvider(credential, [
        GRAPH_DEFAULT_SCOPE,
      ]);
      const requestAdapter = new GraphRequestAdapter(authProvider);
      this.graphClient = createGraphServiceClient(requestAdapter);
      this.graphCredential = credential;
      logger.info("[MSTeamsProvider] Graph client initialized");
    } else {
      logger.info(
        "[MSTeamsProvider] Graph API not configured, thread history unavailable",
      );
    }
  }

  async cleanup(): Promise<void> {
    this.adapter = null;
    this.authorize = null;
    this.graphClient = null;
    this.graphCredential = null;
    this.eventHandler = null;
    logger.info("[MSTeamsProvider] Cleaned up");
  }

  async validateWebhookRequest(
    _payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    const authHeader = headers.authorization || headers.Authorization;
    if (!authHeader) {
      logger.warn("[MSTeamsProvider] Missing Authorization header");
      return false;
    }
    return true;
  }

  handleValidationChallenge(_payload: unknown): unknown | null {
    return null;
  }

  async parseWebhookNotification(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<IncomingChatMessage | null> {
    if (!this.adapter) {
      logger.error("[MSTeamsProvider] Adapter not initialized");
      return null;
    }

    const activity = payload as {
      type?: string;
      id?: string;
      text?: string;
      channelId?: string;
      conversation?: {
        id?: string;
        tenantId?: string;
        conversationType?: string;
      };
      from?: { id?: string; name?: string; aadObjectId?: string };
      recipient?: { id?: string; name?: string };
      timestamp?: string;
      replyToId?: string;
      serviceUrl?: string;
      channelData?: {
        team?: { id?: string; aadGroupId?: string };
        channel?: { id?: string };
        tenant?: { id?: string };
      };
      entities?: Array<{
        type?: string;
        mentioned?: { id?: string; name?: string };
      }>;
      attachments?: Array<{
        contentType?: string;
        contentUrl?: string;
        content?: string;
        name?: string;
      }>;
    };

    logger.debug(
      {
        conversationType: activity.conversation?.conversationType,
        teamId: activity.channelData?.team?.id,
        aadGroupId: activity.channelData?.team?.aadGroupId,
        isReply: Boolean(activity.replyToId),
      },
      "[MSTeamsProvider] Parsing activity",
    );

    if (activity.type !== ActivityTypes.Message) {
      return null;
    }

    // A file-only message (empty text but with a real file attachment) is still
    // meaningful, so accept it; only drop messages that carry neither text nor
    // a downloadable file. Adaptive Cards / hero cards are not files (and are
    // filtered out before download), so a card-only message stays dropped.
    // Addressing/mention gating is enforced by the webhook route, not here, so
    // this does not widen who the bot responds to.
    const hasFileAttachment = Boolean(
      activity.attachments?.some(
        (a) =>
          a.contentUrl &&
          a.contentType &&
          !a.contentType.startsWith("application/vnd.microsoft.card."),
      ),
    );
    if (!activity.text && !hasFileAttachment) {
      return null;
    }

    // Extract channel ID, stripping thread suffix if present
    let channelId =
      activity.channelData?.channel?.id || activity.conversation?.id;
    if (channelId?.includes(";messageid=")) {
      channelId = channelId.split(";messageid=")[0];
    }

    if (!channelId) {
      logger.warn(
        "[MSTeamsProvider] Cannot determine channel ID from activity",
      );
      return null;
    }

    const cleanedText = cleanBotMention(
      activity.text ?? "",
      activity.recipient?.name,
    );
    if (!cleanedText && !hasFileAttachment) {
      return null;
    }

    // Note: in team channels the bot stays quiet until @mentioned, then keeps
    // replying to the thread. That gating is enforced by the webhook route via
    // wasBotMentioned() + channel-activation, not here, so parsing stays pure.

    // Only team channels have reply threads. A 1:1 or group chat is one flat
    // stream: a quoted reply there still carries a replyToId, which must not
    // split the chat into separate sessions.
    const threadId = isTeamsChannel(activity)
      ? extractThreadId(activity)
      : undefined;
    const conversationId = activity.conversation?.id;
    const isThreadReply =
      isTeamsChannel(activity) &&
      (Boolean(activity.replyToId) ||
        Boolean(conversationId?.includes(";messageid=")));

    // Extract team ID - prefer aadGroupId (proper UUID) over team.id (may be conversation ID)
    const teamData = activity.channelData?.team;
    const workspaceId = teamData?.aadGroupId || teamData?.id || null;

    // Download file attachments (skip Adaptive Cards and other non-file
    // attachments). Current-message drops are intentionally not surfaced for
    // Teams (unlike Slack) — only the delivered attachments are used.
    const fileOutcomes = await this.downloadTeamsFiles(
      filterTeamsFileAttachments(activity.attachments),
      activity.serviceUrl,
    );
    const attachments = fileOutcomes.flatMap((o) =>
      o.status === "delivered" ? [o.attachment] : [],
    );

    // A file-only message (empty text) is kept only when a file actually
    // survived download — oversized, expired, or failed downloads must not
    // leave the bot answering an empty turn.
    if (!cleanedText && attachments.length === 0) {
      return null;
    }

    return {
      messageId: activity.id || `teams-${Date.now()}`,
      channelId,
      workspaceId,
      threadId,
      senderId: activity.from?.aadObjectId || activity.from?.id || "unknown",
      senderName: activity.from?.name || "Unknown User",
      text: cleanedText,
      rawText: activity.text ?? "",
      timestamp: activity.timestamp ? new Date(activity.timestamp) : new Date(),
      isThreadReply,
      metadata: {
        tenantId:
          activity.channelData?.tenant?.id || activity.conversation?.tenantId,
        serviceUrl: activity.serviceUrl,
        conversationReference:
          Activity.fromObject(activity).getConversationReference(),
        authHeader: headers.authorization || headers.Authorization,
        // Lets the manager frame group conversations for the agent ("personal",
        // "groupChat", or "channel") and tell it whether it was addressed.
        conversationType: activity.conversation?.conversationType,
        botMentioned: this.wasBotMentioned(activity),
        botName: activity.recipient?.name,
        // Names of OTHER people @mentioned in the message — a message
        // @mentioning someone else is most likely addressed to them.
        mentionedOthers: extractMentionedOthers(activity),
      },
      ...(attachments.length > 0 && { attachments }),
    };
  }

  /**
   * Whether this activity @mentions the bot.
   *
   * Normalizes IDs before comparing (strips the "28:" prefix, case-insensitive)
   * since Teams may format recipient.id and the mention's id differently. The
   * webhook route uses this to gate team-channel replies (see channel-activation).
   */
  wasBotMentioned(activity: {
    recipient?: { id?: string } | null;
    entities?: Array<{
      type?: string;
      mentioned?: { id?: string } | null;
    } | null> | null;
  }): boolean {
    const botId = activity.recipient?.id;
    if (!botId) {
      return false;
    }
    return Boolean(
      activity.entities?.some(
        (e) =>
          e?.type === "mention" &&
          e.mentioned?.id != null &&
          normalizeTeamsId(e.mentioned.id) === normalizeTeamsId(botId),
      ),
    );
  }

  /**
   * If this is a "mute the thread" reaction on one of the bot's channel
   * messages, return the channel + thread to mute; otherwise null.
   *
   * Teams only delivers messageReaction events for the bot's OWN messages, so
   * no sender check is needed. The thread is taken from `conversation.id`'s
   * `;messageid=<root>` — NOT `replyToId`, which on a reaction points at the
   * reacted (bot reply) message rather than the thread root the activation was
   * keyed on. If the root can't be resolved we return null and the caller
   * no-ops loudly (no false "muted") rather than guessing a key — guessing the
   * channelId fallback could clear a different thread's activation.
   */
  parseMuteReaction(activity: {
    type?: string;
    conversation?: { id?: string; conversationType?: string };
    channelData?: { channel?: { id?: string } };
    reactionsAdded?: Array<{ type?: string } | null> | null;
  }): { channelId: string; threadId: string } | null {
    if (activity.type !== "messageReaction") return null;
    const hasMuteReaction = Boolean(
      activity.reactionsAdded?.some((r) => r?.type && isMuteReaction(r.type)),
    );
    if (!hasMuteReaction) return null;

    // Sticky auto-reply (and thus muting) only applies in team channels.
    if (activity.conversation?.conversationType !== "channel") return null;

    const conversationId = activity.conversation?.id;
    // Match how the gate derived the activation key's channelId
    // (parseWebhookNotification): prefer channelData.channel.id, else the
    // thread-suffix-stripped conversation id. Uses `||` (not `??`) to match the
    // gate exactly, so an empty channel.id falls through to the conversation id.
    const channelId =
      activity.channelData?.channel?.id || stripThreadSuffix(conversationId);
    // Assumes the activation key's threadId equals the conversation's
    // `;messageid=<root>`. Teams channel threads are flat (every reply's
    // replyToId is the root), so the gate's extractThreadId (replyToId-first)
    // and this resolve to the same root. If a payload ever breaks that, the
    // mute no-ops loudly (returns null → no false "muted") rather than guessing.
    const threadId = extractThreadIdFromConversationId(conversationId);
    if (!channelId || !threadId) return null;

    return { channelId, threadId };
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    if (!this.adapter) {
      throw new Error("MSTeamsProvider not initialized");
    }

    // The model sometimes signs off with the branding footer itself, having
    // seen it on earlier bot replies replayed as thread history; drop that echo
    // so the reply renders exactly one footer.
    let replyText = options.footer
      ? stripDuplicateAgentFooter(options.text, options.footer)
      : options.text;
    // An even-more-subtle hint (e.g. the one-time mute tip) on its own italic
    // line ABOVE the footer, so the agent footer stays the last line. Italics
    // keep it visually quieter than the footer.
    const hints = [
      options.hint,
      options.conversationUrl &&
        `[Open conversation](${options.conversationUrl})`,
    ].filter(Boolean);
    if (hints.length > 0) {
      replyText += `\n\n---\n\n_${hints.join(" · ")}_`;
    }
    if (options.footer) {
      replyText +=
        hints.length > 0
          ? `\n\n${options.footer}`
          : `\n\n---\n\n${options.footer}`;
    }

    // If a placeholder "Thinking..." message was sent (Teams channels),
    // update it with the actual response instead of sending a new message.
    const placeholderActivityId = options.originalMessage.metadata
      ?.placeholderActivityId as string | undefined;
    const turnContext = options.originalMessage.metadata?.turnContext;
    if (placeholderActivityId && turnContext instanceof TurnContext) {
      try {
        await turnContext.updateActivity(
          Activity.fromObject({
            id: placeholderActivityId,
            type: ActivityTypes.Message,
            text: replyText,
          }),
        );
        delete options.originalMessage.metadata?.placeholderActivityId;
        return placeholderActivityId;
      } catch (error) {
        logger.debug(
          { error: errorMessage(error) },
          "[MSTeamsProvider] Failed to update placeholder, sending new message",
        );
        // Fall through to send a new message
      }
    }

    const ref =
      (options.conversationReference as ConversationReference | undefined) ||
      (options.originalMessage.metadata?.conversationReference as
        | ConversationReference
        | undefined);

    if (!ref) {
      throw new Error("No conversation reference available for reply");
    }

    let messageId = "";
    try {
      await this.adapter.continueConversation(
        this.config.appId,
        ref,
        async (context) => {
          if (placeholderActivityId && !(turnContext instanceof TurnContext)) {
            try {
              await context.updateActivity(
                Activity.fromObject({
                  id: placeholderActivityId,
                  type: ActivityTypes.Message,
                  text: replyText,
                }),
              );
              delete options.originalMessage.metadata?.placeholderActivityId;
              messageId = placeholderActivityId;
              return;
            } catch (error) {
              logger.debug(
                { error: errorMessage(error) },
                "[MSTeamsProvider] Failed to update detached placeholder, sending new message",
              );
            }
          }
          const response = await context.sendActivity(replyText);
          messageId = response?.id || "";
        },
      );
    } catch (error) {
      logger.error(
        { error: errorMessage(error) },
        "[MSTeamsProvider] continueConversation failed",
      );
      throw error;
    }

    return messageId;
  }

  async getThreadHistory(
    params: ThreadHistoryParams,
  ): Promise<ChatThreadMessage[]> {
    if (!this.graphClient) {
      logger.warn(
        "[MSTeamsProvider] Graph client not initialized, skipping thread history",
      );
      return [];
    }

    const limit = Math.min(
      params.limit || CHATOPS_THREAD_HISTORY.DEFAULT_LIMIT,
      CHATOPS_THREAD_HISTORY.MAX_LIMIT,
    );

    try {
      // Determine if this is a group chat vs team channel:
      // - Group chats: no workspaceId, or workspaceId starts with "19:" (thread ID format)
      // - Team channels: workspaceId is a UUID (the team's aadGroupId), channelId contains @thread.tacv2
      let workspaceId = params.workspaceId;
      const isValidTeamId = workspaceId && isUuid(workspaceId);

      // If workspaceId isn't a valid UUID but channel looks like a team channel,
      // try to look up the actual team ID
      const looksLikeTeamChannel = params.channelId.includes("@thread.tacv2");
      if (!isValidTeamId && looksLikeTeamChannel) {
        // workspaceId should already be resolved by the route handler via msTeamsDirectory.
        // Falling back to lookupTeamIdFromChannel (requires Azure AD app permissions).
        logger.warn(
          { channelId: params.channelId, workspaceId },
          "[MSTeamsProvider] workspaceId not resolved to UUID — falling back to Graph API lookup",
        );
        const resolvedTeamId = await this.lookupTeamIdFromChannel(
          params.channelId,
          workspaceId || undefined,
        );
        if (resolvedTeamId) {
          workspaceId = resolvedTeamId;
        }
      }

      const isTeamIdValid = workspaceId && isUuid(workspaceId);
      const isTeamChannel = isTeamIdValid && looksLikeTeamChannel;
      const isGroupChat = !isTeamChannel;

      logger.debug(
        { isGroupChat, isTeamChannel, channelId: params.channelId },
        "[MSTeamsProvider] Fetching thread history",
      );

      const effectiveParams = { ...params, workspaceId };
      const messages = isGroupChat
        ? await this.fetchGroupChatHistory(effectiveParams, limit)
        : await this.fetchTeamChannelHistory(effectiveParams, limit);

      const converted = this.convertToThreadMessages(
        messages,
        params.excludeMessageId,
      );

      logger.debug(
        { historyCount: converted.length },
        "[MSTeamsProvider] Thread history fetched",
      );

      return converted;
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), channelId: params.channelId },
        "[MSTeamsProvider] Failed to fetch thread history",
      );
      return [];
    }
  }

  async addApprovalRequestForm(
    options: AddApprovalRequestFormOptions,
  ): Promise<void> {
    if (!this.adapter) {
      throw new Error("MSTeamsProvider not initialized");
    }

    const approvalCard = buildApprovalRequestCard(options);
    const approvalMessage = Activity.fromObject({
      type: ActivityTypes.Message,
      text: "",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: approvalCard,
        },
      ],
    });

    const turnContext = options.originalMessage.metadata?.turnContext;
    if (turnContext instanceof TurnContext) {
      await turnContext.sendActivity(approvalMessage);
      return;
    }

    const conversationReference = options.originalMessage.metadata
      ?.conversationReference as ConversationReference | undefined;
    if (!conversationReference) {
      throw new Error(
        "No conversation reference available for Teams approval request",
      );
    }

    await this.adapter.continueConversation(
      this.config.appId,
      conversationReference,
      async (context) => {
        await context.sendActivity(approvalMessage);
      },
    );
  }

  async updateApprovalRequest(
    _options: UpdateApprovalRequestOptions,
  ): Promise<void> {
    // In ms-teams we use a callback for status update instead of this function.
  }

  getAdapter(): CloudAdapter | null {
    return this.adapter;
  }

  /**
   * Look up the team ID (UUID) from a channel ID using Graph API.
   * This is needed when the Bot Framework doesn't provide the team's aadGroupId.
   * Caches results to avoid repeated lookups.
   *
   * @param channelId - The specific channel ID where the message was sent
   * @param teamChannelHint - Optional: the team.id from activity (often the General channel ID)
   */
  private teamIdCache = new LRUCacheManager<string | null>({
    maxSize: CHATOPS_TEAM_CACHE.MAX_SIZE,
    defaultTtl: CHATOPS_TEAM_CACHE.TTL_MS,
  });

  private async lookupTeamIdFromChannel(
    channelId: string,
    teamChannelHint?: string,
  ): Promise<string | null> {
    // Use composite cache key including hint to ensure we re-lookup when hint changes
    const cacheKey = teamChannelHint
      ? `${channelId}|${teamChannelHint}`
      : channelId;

    const cached = this.teamIdCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    if (!this.graphClient) {
      logger.warn("[MSTeamsProvider] No graph client for team lookup");
      return null;
    }

    try {
      // List all teams the app has access to and find the one containing this channel.
      // Requires Team.ReadBasic.All and Channel.ReadBasic.All application permissions.
      // Paginate through all teams since Graph API defaults to 20 per page.

      // Build set of channel IDs to match - both the specific channel and the team hint (often General channel)
      const channelsToMatch = new Set([channelId]);
      if (teamChannelHint && teamChannelHint !== channelId) {
        channelsToMatch.add(teamChannelHint);
      }

      let teamsResponse = await this.graphClient.teams.get({
        queryParameters: { top: 999 },
      });

      while (teamsResponse) {
        const teams = teamsResponse.value || [];

        for (const team of teams) {
          if (!team.id) continue;

          try {
            const channelsResponse = await this.graphClient.teams
              .byTeamId(team.id)
              .channels.get();
            const channels = channelsResponse?.value || [];

            // Check if any of the team's channels matches either channelId or teamChannelHint
            const matchedChannel = channels.find(
              (ch) => ch.id && channelsToMatch.has(ch.id),
            );
            if (matchedChannel) {
              logger.info(
                {
                  channelId,
                  matchedChannelId: matchedChannel.id,
                  teamId: team.id,
                  teamName: team.displayName,
                },
                "[MSTeamsProvider] Found team for channel",
              );
              this.teamIdCache.set(cacheKey, team.id);
              return team.id;
            }
          } catch (err) {
            logger.debug(
              { teamId: team.id, error: errorMessage(err) },
              "[MSTeamsProvider] Could not access team channels",
            );
          }
        }

        // Follow @odata.nextLink for the next page of teams
        if (teamsResponse.odataNextLink) {
          teamsResponse = await this.graphClient.teams
            .withUrl(teamsResponse.odataNextLink)
            .get();
        } else {
          break;
        }
      }

      logger.warn(
        { channelId },
        "[MSTeamsProvider] Could not find team for channel - thread history may be limited",
      );
      this.teamIdCache.set(cacheKey, null);
      return null;
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), channelId },
        "[MSTeamsProvider] Failed to lookup team from channel. " +
          "This is only needed with Azure AD application permissions (not RSC). " +
          "Team.ReadBasic.All and Channel.ReadBasic.All permissions are required.",
      );
      this.teamIdCache.set(cacheKey, null);
      return null;
    }
  }

  /**
   * Get user's email from their AAD Object ID using Microsoft Graph API.
   * Fallback method when msTeamsDirectory.getMember() is unavailable.
   * Requires User.Read.All application permission.
   */
  async getUserEmail(aadObjectId: string): Promise<string | null> {
    if (!this.graphClient) {
      logger.warn(
        "[MSTeamsProvider] Graph client not configured, cannot resolve user email",
      );
      return null;
    }

    try {
      const user = await this.graphClient.users.byUserId(aadObjectId).get();
      return user
        ? await resolveMSTeamsUserEmail({
            email: user.mail,
            userPrincipalName: user.userPrincipalName,
          })
        : null;
    } catch (error) {
      logger.error(
        { error: errorMessage(error), aadObjectId },
        "[MSTeamsProvider] Failed to fetch user email via Graph API fallback. User.Read.All permission may be missing.",
      );
      return null;
    }
  }

  async getChannelName(_channelId: string): Promise<string | null> {
    // MS Teams channel names are resolved during discoverChannels via TurnContext
    return null;
  }

  getWorkspaceId(): string | null {
    // MS Teams requires a TurnContext to determine the team — no eager discovery
    return null;
  }

  getWorkspaceName(): string | null {
    // MS Teams workspace name is per-team — resolved from TurnContext at message time
    return null;
  }

  async discoverChannels(
    context: unknown,
  ): Promise<DiscoveredChannel[] | null> {
    if (!(context instanceof TurnContext)) return null;

    const teamData = context.activity.channelData?.team as
      | { id?: string; aadGroupId?: string }
      | undefined;
    if (!teamData?.id) return null;

    const [channels, teamDetails] = await Promise.all([
      msTeamsDirectory.getTeamChannels(context),
      msTeamsDirectory.getTeamDetails(context).catch(() => null),
    ]);

    if (!channels?.length) return null;

    // Prefer aadGroupId (stable UUID) over thread-format team.id.
    // channelData.team.aadGroupId is often absent, so fall back to
    // the value returned by msTeamsDirectory.getTeamDetails().
    const workspaceId =
      teamData.aadGroupId || teamDetails?.aadGroupId || teamData.id;

    return channels
      .filter((ch): ch is typeof ch & { id: string } => !!ch.id)
      .map((ch) => ({
        channelId: ch.id,
        channelName: ch.name ?? "General",
        workspaceId,
        workspaceName: teamDetails?.name ?? null,
      }));
  }

  async sendEphemeralMessage(params: {
    channelId: string;
    userId: string;
    text: string;
    threadId?: string;
  }): Promise<void> {
    // Teams doesn't have true ephemeral messages.
    // Send a 1:1 DM to the user via proactive messaging if possible.
    if (!this.adapter) return;
    // For now, log a note — the welcome message is sent as part of the
    // regular reply flow in the Teams route handler via context.sendActivity.
    logger.debug(
      { userId: params.userId },
      "[MSTeamsProvider] Ephemeral message requested (sent via turn context in route handler)",
    );
  }

  async setTypingStatus(
    _channelId: string,
    _threadTs: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const turnContext = metadata?.turnContext;
      if (turnContext instanceof TurnContext) {
        const isChannel =
          turnContext.activity.conversation?.conversationType === "channel";

        if (isChannel) {
          // Teams channels don't render typing indicators from bots.
          // Send a placeholder message that will be updated with the real response.
          const response = await turnContext.sendActivity("Thinking...");
          if (response?.id && metadata) {
            metadata.placeholderActivityId = response.id;
          }
        } else {
          // DMs and group chats support native typing indicators
          await turnContext.sendActivity(
            Activity.fromObject({ type: ActivityTypes.Typing }),
          );
        }
        return;
      }

      // Fallback: proactive messaging via continueConversation.
      // Works for DMs/group chats but not for channel typing indicators.
      if (!this.adapter) return;
      const ref = metadata?.conversationReference as
        | ConversationReference
        | undefined;
      if (!ref) return;

      await this.adapter.continueConversation(
        this.config.appId,
        ref,
        async (context) => {
          await context.sendActivity(
            Activity.fromObject({ type: ActivityTypes.Typing }),
          );
        },
      );
    } catch (error) {
      logger.debug(
        { error: errorMessage(error) },
        "[MSTeamsProvider] setTypingStatus failed (non-fatal)",
      );
    }
  }

  async clearTypingStatus(
    _channelId: string,
    _threadTs: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const placeholderActivityId = metadata?.placeholderActivityId;
    if (typeof placeholderActivityId !== "string") return;
    const turnContext = metadata?.turnContext;
    if (turnContext instanceof TurnContext) {
      await turnContext.deleteActivity(placeholderActivityId);
    } else {
      const ref = metadata?.conversationReference as
        | ConversationReference
        | undefined;
      if (!this.adapter || !ref) return;
      await this.adapter.continueConversation(
        this.config.appId,
        ref,
        async (context) => {
          await context.deleteActivity(placeholderActivityId);
        },
      );
    }
    delete metadata?.placeholderActivityId;
  }

  async processActivity(
    req: {
      body: unknown;
      headers: Record<string, string | string[] | undefined>;
    },
    res: {
      status: (code: number) => { send: (data?: unknown) => void };
      send: (data?: unknown) => void;
    },
    handler: (context: TurnContext) => Promise<void>,
  ): Promise<void> {
    if (!this.adapter || !this.authorize) {
      throw new Error("MSTeamsProvider not initialized");
    }

    // The Agents SDK adapter trusts request.user; it does not authenticate
    // requests itself. Keep Microsoft's JWT middleware in front of it.
    const request: Request = {
      body: req.body as Record<string, unknown>,
      headers: {
        ...req.headers,
        authorization: req.headers.authorization ?? req.headers.Authorization,
      },
      method: "POST",
    };
    let status = 200;
    const response: WebResponse = {
      headersSent: false,
      writableEnded: false,
      status(code) {
        status = code;
        return this;
      },
      setHeader() {
        return this;
      },
      send(body) {
        if (!this.writableEnded) {
          this.headersSent = true;
          this.writableEnded = true;
          res.status(status).send(body);
        }
        return this;
      },
      end() {
        return this.send();
      },
    };
    let authenticated = false;
    await this.authorize(request, response, () => {
      authenticated = true;
    });
    if (!authenticated) return;

    await this.adapter.process(request, response, async (context) => {
      // Acknowledge ordinary activities before doing any network/agent work.
      // Keep this callback alive until all work finishes: returning it early
      // revokes the TurnContext used for cards, typing and threaded replies.
      // Invoke and expectReplies activities require the SDK's response body.
      if (
        context.activity.type !== ActivityTypes.Invoke &&
        context.activity.deliveryMode !== "expectReplies"
      ) {
        response.status(200).end();
      }
      const approvalPayload = this.parseApprovalDecisionPayload(
        context.activity.value,
      );
      if (approvalPayload) {
        await this.handleApprovalDecisionSubmission(context, approvalPayload);
        return;
      }
      await handler(context);
    });
  }

  parseInteractivePayload(_payload: unknown): {
    agentId: string;
    channelId: string;
    workspaceId: string | null;
    threadTs?: string;
    userId: string;
    userName: string;
    responseUrl: string;
  } | null {
    // MS Teams handles interactive selections inline via Adaptive Card submissions
    // in the route handler (TurnContext.activity.value), not through this method.
    return null;
  }

  private parseApprovalDecisionPayload(payload: unknown): {
    approvalId: string;
    approved: boolean;
    toolName?: string;
    toolLabel?: string;
    taskId: string;
    channelId?: string;
    workspaceId?: string | null;
    threadId?: string;
    originalSenderEmail?: string;
    messageId?: string;
  } | null {
    const p = payload as { action?: string };
    if (p?.action !== "approvalDecision") {
      return null;
    }
    const value = payload as {
      action?: string;
      approvalId?: unknown;
      approved?: unknown;
      toolName?: unknown;
      toolLabel?: unknown;
      taskId?: unknown;
      channelId?: unknown;
      workspaceId?: unknown;
      threadId?: unknown;
      originalSenderEmail?: unknown;
      messageId?: unknown;
    };
    return {
      approvalId: value.approvalId as string,
      approved: value.approved as boolean,
      toolName: value.toolName as string | undefined,
      toolLabel:
        typeof value.toolLabel === "string" ? value.toolLabel : undefined,
      taskId: value.taskId as string,
      channelId: value.channelId as string | undefined,
      workspaceId: value.workspaceId as string | null | undefined,
      threadId: value.threadId as string | undefined,
      originalSenderEmail: value.originalSenderEmail as string | undefined,
      messageId: value.messageId as string | undefined,
    };
  }

  private async handleApprovalDecisionSubmission(
    context: TurnContext,
    payload: {
      approvalId: string;
      approved: boolean;
      toolName?: string;
      toolLabel?: string;
      taskId: string;
      channelId?: string;
      workspaceId?: string | null;
      threadId?: string;
      messageId?: string;
      originalSenderEmail?: string;
    },
  ): Promise<void> {
    const senderId =
      context.activity.from?.aadObjectId ||
      context.activity.from?.id ||
      "unknown";
    let senderEmail: string | null = null;
    try {
      const member = await msTeamsDirectory.getMember(
        context,
        context.activity.from?.id || senderId,
      );
      if (member?.email || member?.userPrincipalName) {
        senderEmail = await resolveMSTeamsUserEmail(member);
      }
    } catch (error) {
      logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        "[MSTeamsProvider] msTeamsDirectory.getMember failed for approval decision, will fall back to Graph API if configured",
      );
    }

    if (!senderEmail) {
      senderEmail = await this.getUserEmail(senderId);
    }
    if (!senderEmail) {
      logger.warn(
        { senderId },
        "[MSTeamsProvider] Could not resolve user email for approval decision",
      );
      return;
    }

    const teamData = context.activity.channelData?.team as
      | { id?: string; aadGroupId?: string }
      | undefined;
    const channelId =
      payload.channelId ||
      context.activity.channelData?.channel?.id ||
      context.activity.conversation?.id ||
      "";
    const workspaceId =
      payload.workspaceId !== undefined
        ? payload.workspaceId
        : teamData?.aadGroupId || teamData?.id || null;
    const threadId =
      payload.threadId ||
      (isTeamsChannel(context.activity)
        ? extractThreadId(context.activity)
        : undefined) ||
      undefined;
    const messageId =
      payload.messageId ||
      context.activity.replyToId ||
      context.activity.id ||
      `teams-${Date.now()}`;

    const originalMessage: IncomingChatMessage = {
      messageId,
      channelId,
      workspaceId,
      threadId,
      senderId,
      senderEmail: payload.originalSenderEmail,
      senderName: context.activity.from?.name || "Unknown User",
      text: "",
      rawText: "",
      timestamp: context.activity.timestamp
        ? new Date(context.activity.timestamp)
        : new Date(),
      isThreadReply: Boolean(threadId),
      metadata: {
        conversationType: context.activity.conversation?.conversationType,
        turnContext: context,
        conversationReference: context.activity.getConversationReference(),
      },
    };

    const decision: ChatOpsApprovalDecision = {
      taskId: payload.taskId,
      approvalId: payload.approvalId,
      approved: payload.approved,
      toolName: payload.toolName || "",
      messageTs: messageId,
      channelId,
      workspaceId,
      originalMessage,
      threadTs: threadId,
      userId: senderId,
      userName: originalMessage.senderName,
      responseUrl: "",
      approverEmail: senderEmail,
    };

    const updateApprovalRequestCallback = async (): Promise<void> => {
      const approvalMessageId =
        context.activity.replyToId || context.activity.id;
      if (!approvalMessageId) {
        return;
      }

      await context.updateActivity(
        Activity.fromObject({
          id: approvalMessageId,
          type: ActivityTypes.Message,
          text: "",
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: buildApprovalDecisionCard({
                toolLabel: payload.toolLabel,
                approved: payload.approved,
                deciderName: context.activity.from?.name,
              }),
            },
          ],
        }),
      );
    };

    if (!this.eventHandler) {
      logger.warn(
        "[MSTeamsProvider] No event handler registered for approval decision",
      );
      return;
    }

    await this.eventHandler.handleInteractiveApprovalDecision(
      this,
      decision,
      updateApprovalRequestCallback,
    );
  }

  async sendAgentSelectionCard(params: {
    message: IncomingChatMessage;
    agents: { id: string; name: string }[];
    isWelcome: boolean;
    providerContext?: unknown;
  }): Promise<void> {
    const context = params.providerContext;
    if (!(context instanceof TurnContext)) {
      throw new Error(
        "MSTeamsProvider.sendAgentSelectionCard requires a TurnContext",
      );
    }

    const choices = params.agents.map((agent) => ({
      title: agent.name,
      value: agent.id,
    }));

    // Check for existing binding to pre-select
    const existingBinding = await ChatOpsChannelBindingModel.findByChannel({
      provider: "ms-teams",
      channelId: params.message.channelId,
      workspaceId: params.message.workspaceId,
    });

    const cardBody = existingBinding?.agentId
      ? [
          {
            type: "TextBlock",
            size: "Medium",
            weight: "Bolder",
            text: "Change Default Agent",
          },
          {
            type: "TextBlock",
            text: "Select a different agent to handle messages in this channel:",
            wrap: true,
          },
          {
            type: "Input.ChoiceSet",
            id: "agentId",
            style: "compact",
            value: existingBinding.agentId,
            choices,
          },
        ]
      : [
          {
            type: "TextBlock",
            text: "Each Microsoft Teams channel needs a **default agent** assigned to it. This agent will handle all your requests in this channel by default.",
            wrap: true,
            spacing: "Small",
          },
          {
            type: "TextBlock",
            text: `**Tip:** You can use other agents with the syntax **AgentName >** (e.g., @${archestraMcpBranding.appName} Sales > what's the status?).`,
            wrap: true,
            spacing: "Small",
          },
          {
            type: "TextBlock",
            text: "**Available commands:**",
            wrap: true,
            spacing: "Medium",
          },
          {
            type: "FactSet",
            spacing: "Small",
            facts: [
              {
                title: "/select-agent",
                value:
                  "Change the default agent handling requests in the channel",
              },
              {
                title: "/status",
                value:
                  "Check the current agent handling requests in the channel",
              },
              { title: "/help", value: "Show available commands" },
            ],
          },
          {
            type: "TextBlock",
            text: "**Let's set the default agent for this channel:**",
            wrap: true,
            spacing: "Medium",
          },
          {
            type: "Input.ChoiceSet",
            id: "agentId",
            style: "compact",
            value: choices[0]?.value || "",
            choices,
          },
        ];

    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: cardBody,
      actions: [
        {
          type: "Action.Submit",
          title: "Confirm Selection",
          data: {
            action: "selectAgent",
            channelId: params.message.channelId,
            workspaceId: params.message.workspaceId,
            originalMessageText: params.message.text || undefined,
            pendingAttachmentsKey: await this.stashAgentSelectionAttachments(
              params.message,
            ),
          },
        },
      ],
    };

    await context.sendActivity(
      Activity.fromObject({
        type: ActivityTypes.Message,
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: card,
          },
        ],
      }),
    );
  }

  hasMissingScopes(): boolean {
    return false;
  }

  async notifyMissingScopes(): Promise<void> {
    // No-op: MS Teams permissions are managed in Azure AD and can't be detected at runtime
  }

  /**
   * Files of the message that triggered an agent-selection card, so the
   * replay after **Confirm Selection** answers the whole message. Only the
   * original sender, in the original conversation, receives them, once.
   */
  async takeAgentSelectionAttachments(params: {
    key: string;
    senderId: string;
    channelId: string;
  }): Promise<A2AAttachment[]> {
    if (!isUuid(params.key)) return [];
    const cacheKey =
      `${CacheKey.TeamsAgentSelectionAttachments}-${params.key}` as const;
    const pending =
      await cacheManager.get<PendingAgentSelectionAttachments>(cacheKey);
    if (
      !pending ||
      pending.senderId !== params.senderId ||
      pending.channelId !== params.channelId
    ) {
      return [];
    }
    await cacheManager.delete(cacheKey);
    return pending.attachments;
  }

  async downloadFiles(
    files: ChatThreadMessageFile[],
  ): Promise<ThreadFileOutcome[]> {
    // No serviceUrl for history messages: Azure Blob URLs are pre-authenticated
    // and Graph hosted-content images authenticate with the Graph app token.
    return this.downloadTeamsFiles(
      files.map((f) => ({
        contentType: f.mimetype,
        contentUrl: f.url,
        name: f.name,
        size: f.size,
      })),
    );
  }

  // ===========================================================================
  // Private Methods

  /**
   * Hold the message's files until the agent is picked. The card carries only
   * the returned key: Teams echoes card data back from the client, so file
   * references placed in it could be swapped for another conversation's.
   */
  private async stashAgentSelectionAttachments(
    message: IncomingChatMessage,
  ): Promise<string | undefined> {
    if (!message.attachments?.length) return undefined;
    const key = randomUUID();
    const pending: PendingAgentSelectionAttachments = {
      senderId: message.senderId,
      channelId: message.channelId,
      attachments: message.attachments,
    };
    try {
      await cacheManager.set(
        `${CacheKey.TeamsAgentSelectionAttachments}-${key}`,
        pending,
        AGENT_SELECTION_ATTACHMENTS_TTL_MS,
      );
      return key;
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[MSTeamsProvider] Could not hold attachments for the agent-selection replay",
      );
      return undefined;
    }
  }

  /**
   * Download Teams file attachments and convert to A2AAttachment format.
   *
   * Returns exactly one outcome per input file, positionally aligned with
   * `files` — the delivered attachment or the reason it was dropped — so
   * callers can attribute every skip to the message the file came from.
   *
   * Authentication: Files uploaded directly in Teams chat use pre-authenticated Azure
   * Blob Storage URLs. Files shared from SharePoint/OneDrive may require a Bearer token.
   * When the contentUrl hostname matches the Bot Framework serviceUrl, we authenticate
   * using client credentials (appId/appSecret) to obtain a Bot Connector token.
   * Images pasted inline into a message reach thread history only as Graph
   * hosted-content URLs, which take the Graph app token instead.
   */
  private async downloadTeamsFiles(
    files: TeamsFileAttachment[],
    serviceUrl?: string,
  ): Promise<ThreadFileOutcome[]> {
    if (files.length === 0) return [];

    const outcomes: ThreadFileOutcome[] = [];
    const skip = (skipped: SkippedAttachment): void => {
      outcomes.push({ status: "skipped", skipped });
    };
    let totalSize = 0;
    let deliveredCount = 0;
    // Once the combined budget is spent, every remaining file is recorded as
    // over-budget rather than silently dropped (the old code `break`-ed here).
    let budgetExhausted = false;

    // Lazily obtain a Bot Connector token when needed for authenticated downloads
    let botToken: string | null = null;

    for (const [index, attachment] of files.entries()) {
      // Anything past the per-message cap is dropped from processing; record
      // it rather than letting it vanish silently.
      if (index >= CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE) {
        skip({
          name: attachment.name,
          sizeBytes: attachment.size,
          reason: "too_many",
        });
        continue;
      }

      if (budgetExhausted) {
        skip({
          name: attachment.name,
          sizeBytes: attachment.size,
          reason: "total_limit_reached",
        });
        continue;
      }

      // SSRF protection: only allow downloads from known Microsoft domains
      if (!isAllowedTeamsFileHost(attachment.contentUrl, serviceUrl)) {
        logger.warn(
          {
            name: attachment.name,
            host: safeHostname(attachment.contentUrl),
          },
          "[MSTeamsProvider] Skipping attachment from unexpected domain",
        );
        skip({
          name: attachment.name,
          sizeBytes: attachment.size,
          reason: "download_failed",
        });
        continue;
      }

      try {
        // Determine if the URL needs authentication (same host as serviceUrl)
        const headers: Record<string, string> = {};
        if (isGraphUrl(attachment.contentUrl)) {
          const graphToken = await this.getGraphToken();
          if (graphToken) {
            headers.Authorization = `Bearer ${graphToken}`;
          }
        } else if (
          serviceUrl &&
          needsBotAuth(attachment.contentUrl, serviceUrl)
        ) {
          if (!botToken) {
            botToken = await this.getBotConnectorToken();
          }
          if (botToken) {
            headers.Authorization = `Bearer ${botToken}`;
          }
        }

        const response = await fetch(
          attachment.contentUrl,
          Object.keys(headers).length > 0 ? { headers } : undefined,
        );

        if (!response.ok) {
          logger.warn(
            {
              name: attachment.name,
              contentType: attachment.contentType,
              status: response.status,
            },
            "[MSTeamsProvider] Failed to download attachment",
          );
          skip({
            name: attachment.name,
            sizeBytes: attachment.size,
            reason: "download_failed",
          });
          continue;
        }

        // Pre-check Content-Length to avoid buffering oversized files
        const contentLength = Number.parseInt(
          response.headers.get("content-length") || "0",
          10,
        );
        if (
          contentLength > 0 &&
          contentLength > CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE
        ) {
          logger.info(
            { name: attachment.name, contentLength },
            "[MSTeamsProvider] Skipping oversized attachment (Content-Length)",
          );
          skip({
            name: attachment.name,
            sizeBytes: attachment.size || contentLength,
            reason: "too_large",
          });
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        // Skip files that exceed individual size limit
        if (buffer.length > CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE) {
          logger.info(
            {
              name: attachment.name,
              size: buffer.length,
              maxSize: CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE,
            },
            "[MSTeamsProvider] Skipping attachment exceeding size limit",
          );
          skip({
            name: attachment.name,
            sizeBytes: buffer.length,
            reason: "too_large",
          });
          continue;
        }

        // Skip if total size would exceed limit
        if (
          totalSize + buffer.length >
          CHATOPS_ATTACHMENT_LIMITS.MAX_TOTAL_ATTACHMENTS_SIZE
        ) {
          logger.info(
            {
              name: attachment.name,
              totalSize,
              maxTotalSize:
                CHATOPS_ATTACHMENT_LIMITS.MAX_TOTAL_ATTACHMENTS_SIZE,
            },
            "[MSTeamsProvider] Total attachments size limit reached",
          );
          skip({
            name: attachment.name,
            sizeBytes: buffer.length,
            reason: "total_limit_reached",
          });
          budgetExhausted = true;
          continue;
        }

        totalSize += buffer.length;
        deliveredCount++;
        // Resolve content type: prefer HTTP header when specific, fall back to
        // attachment metadata, and detect from magic bytes as last resort when
        // both are generic (e.g. "application/octet-stream" or "image/*").
        const httpContentType =
          response.headers.get("content-type")?.split(";")[0]?.trim() || "";
        const isGenericContentType = (ct: string) =>
          !ct || ct === "application/octet-stream" || ct.includes("*");
        const resolvedContentType = !isGenericContentType(httpContentType)
          ? httpContentType
          : !isGenericContentType(attachment.contentType)
            ? attachment.contentType
            : detectImageType(buffer);
        outcomes.push({
          status: "delivered",
          attachment: {
            contentType: resolvedContentType,
            contentBase64: buffer.toString("base64"),
            name: attachment.name,
          },
        });

        logger.debug(
          {
            name: attachment.name,
            contentType: attachment.contentType,
            size: buffer.length,
          },
          "[MSTeamsProvider] Downloaded Teams attachment",
        );
      } catch (error) {
        logger.warn(
          { name: attachment.name, error: errorMessage(error) },
          "[MSTeamsProvider] Error downloading attachment",
        );
        skip({
          name: attachment.name,
          sizeBytes: attachment.size,
          reason: "download_failed",
        });
      }
    }

    if (deliveredCount > 0) {
      logger.info(
        {
          fileCount: deliveredCount,
          totalSize,
          originalCount: files.length,
        },
        "[MSTeamsProvider] Downloaded attachments from Teams message",
      );
    }

    return outcomes;
  }

  /**
   * Graph app token for hosted-content downloads. The credential caches and
   * refreshes the token itself, so this does not hold one.
   */
  private async getGraphToken(): Promise<string | null> {
    if (!this.graphCredential) return null;
    try {
      const accessToken =
        await this.graphCredential.getToken(GRAPH_DEFAULT_SCOPE);
      return accessToken?.token ?? null;
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[MSTeamsProvider] Error obtaining Graph token for attachment download",
      );
      return null;
    }
  }

  /**
   * Obtain a Bot Connector token via OAuth2 client credentials grant.
   * Used to authenticate downloads from the Bot Framework service URL.
   * Cached for 50 minutes (tokens expire after 60 minutes).
   */
  private botConnectorTokenCache: { token: string; expiresAt: number } | null =
    null;

  private async getBotConnectorToken(): Promise<string | null> {
    // Return cached token if still valid (with 10-minute safety margin)
    if (
      this.botConnectorTokenCache &&
      Date.now() < this.botConnectorTokenCache.expiresAt
    ) {
      return this.botConnectorTokenCache.token;
    }

    const { appId, appSecret, tenantId } = this.config;
    if (!appId || !appSecret) return null;

    const tokenTenant = tenantId || "botframework.com";
    const tokenUrl = `https://login.microsoftonline.com/${tokenTenant}/oauth2/v2.0/token`;

    try {
      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: appId,
          client_secret: appSecret,
          scope: "https://api.botframework.com/.default",
        }),
      });

      if (!response.ok) {
        logger.warn(
          { status: response.status },
          "[MSTeamsProvider] Failed to obtain Bot Connector token for attachment download",
        );
        return null;
      }

      const data = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      const token = data.access_token ?? null;

      if (token) {
        // Cache with 10-minute safety margin before expiry (default 60 min)
        const expiresInMs = ((data.expires_in ?? 3600) - 600) * 1000;
        this.botConnectorTokenCache = {
          token,
          expiresAt: Date.now() + expiresInMs,
        };
      }

      return token;
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[MSTeamsProvider] Error obtaining Bot Connector token",
      );
      return null;
    }
  }

  // ===========================================================================

  private async fetchGroupChatHistory(
    params: ThreadHistoryParams,
    limit: number,
  ): Promise<ChatMessage[]> {
    const client = this.graphClient;
    if (!client) return [];

    const chatMessages = client.chats.byChatId(params.channelId).messages;

    // For thread replies, fetch parent message and attempt to get replies
    if (params.threadId && !params.threadId.includes("@thread")) {
      const parentMessage = await chatMessages
        .byChatMessageId(params.threadId)
        .get();

      try {
        const repliesResponse = await chatMessages
          .byChatMessageId(params.threadId)
          .replies.get({ queryParameters: { top: limit - 1 } });
        return [parentMessage, ...(repliesResponse?.value || [])].filter(
          (msg): msg is ChatMessage => msg !== undefined,
        );
      } catch (error) {
        // /replies endpoint not supported for group chats - use parent message only
        logger.warn(
          { error: errorMessage(error), threadId: params.threadId },
          "[MSTeamsProvider] Thread replies unavailable for group chat (API limitation)",
        );
        return parentMessage ? [parentMessage] : [];
      }
    }

    // No thread - fetch recent messages
    const response = await chatMessages.get({
      queryParameters: { top: limit },
    });
    return response?.value || [];
  }

  private async fetchTeamChannelHistory(
    params: ThreadHistoryParams,
    limit: number,
  ): Promise<ChatMessage[]> {
    const client = this.graphClient;
    if (!client || !params.workspaceId) return [];

    const channelMessages = client.teams
      .byTeamId(params.workspaceId)
      .channels.byChannelId(params.channelId).messages;

    const isThreadReply =
      params.threadId &&
      params.threadId !== params.channelId &&
      !params.threadId.includes("@thread");

    if (isThreadReply) {
      const messageBuilder = channelMessages.byChatMessageId(params.threadId);
      try {
        const [parentResponse, repliesResponse] = await Promise.all([
          messageBuilder.get(),
          messageBuilder.replies.get({ queryParameters: { top: limit - 1 } }),
        ]);
        return [parentResponse, ...(repliesResponse?.value || [])].filter(
          (msg): msg is ChatMessage => msg !== undefined,
        );
      } catch (error) {
        logger.warn(
          { error: errorMessage(error), threadId: params.threadId },
          "[MSTeamsProvider] Failed to fetch thread, falling back to replies only",
        );
        const response = await messageBuilder.replies.get({
          queryParameters: { top: limit },
        });
        return response?.value || [];
      }
    }

    const response = await channelMessages.get({
      queryParameters: { top: limit },
    });
    return response?.value || [];
  }

  private convertToThreadMessages(
    messages: ChatMessage[],
    excludeMessageId?: string,
  ): ChatThreadMessage[] {
    const botAppId = this.config.appId;

    return (
      messages
        .filter((msg) => msg.id && msg.id !== excludeMessageId)
        .map((msg) => {
          const isUserMessage = Boolean(msg.from?.user);

          // Extract file attachment metadata from Graph API ChatMessage.attachments,
          // plus images pasted inline: Graph lists those only in the HTML body.
          const files: ChatThreadMessageFile[] = [
            ...(msg.attachments ?? [])
              .filter(
                (a) =>
                  a.contentUrl &&
                  a.contentType &&
                  !a.contentType.startsWith("application/vnd.microsoft.card."),
              )
              .map((a) => ({
                url: a.contentUrl as string,
                mimetype: a.contentType as string,
                name: a.name ?? undefined,
              })),
            ...extractHostedContentImages(msg.body?.content ?? undefined),
          ];

          return {
            messageId: msg.id as string,
            senderId: isUserMessage
              ? msg.from?.user?.id || "unknown"
              : msg.from?.application?.id || "unknown",
            senderName: isUserMessage
              ? msg.from?.user?.displayName || "Unknown"
              : msg.from?.application?.displayName || "App",
            text: extractMessageText(
              msg.body?.content ?? undefined,
              msg.attachments ?? undefined,
            ),
            timestamp: msg.createdDateTime
              ? new Date(msg.createdDateTime)
              : new Date(),
            isFromBot:
              msg.from?.user?.id === botAppId ||
              msg.from?.application?.id === botAppId,
            ...(files.length > 0 && { files }),
          };
        })
        // Keep text-less USER messages that carry files: a screenshot posted
        // alone is a turn the model must know about — its file is either
        // delivered or surfaced as skipped by the manager. Bot file-only
        // messages stay filtered: the manager never downloads bot files, so
        // retaining them would render a turn with no file and no skip note.
        .filter(
          (msg) =>
            msg.text.trim().length > 0 ||
            (!msg.isFromBot && (msg.files?.length ?? 0) > 0),
        )
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    );
  }
}

export default MSTeamsProvider;

// =============================================================================
// Internal Helpers
// =============================================================================

interface PendingAgentSelectionAttachments {
  senderId: string;
  channelId: string;
  attachments: A2AAttachment[];
}

/** How long an unanswered agent-selection card can still replay its files. */
const AGENT_SELECTION_ATTACHMENTS_TTL_MS = 60 * 60 * 1000;

/** A Teams attachment that points at a downloadable file (not a card). */
interface TeamsFileAttachment {
  contentType: string;
  contentUrl: string;
  name?: string;
  size?: number;
}

/**
 * Keep only file/image attachments (skip Adaptive Cards, hero cards, and
 * entries without a download URL).
 */
function filterTeamsFileAttachments(
  attachments?: Array<{
    contentType?: string;
    contentUrl?: string;
    content?: string;
    name?: string;
  }>,
): TeamsFileAttachment[] {
  return (attachments ?? []).flatMap((a) =>
    a.contentUrl &&
    a.contentType &&
    !a.contentType.startsWith("application/vnd.microsoft.card.")
      ? [{ contentType: a.contentType, contentUrl: a.contentUrl, name: a.name }]
      : [],
  );
}

function cleanBotMention(text: string, botName?: string): string {
  let cleaned = text.replace(/<at>.*?<\/at>/gi, "").trim();
  if (botName) {
    const escapedName = escapeRegExp(botName);
    cleaned = cleaned
      .replace(new RegExp(`@${escapedName}\\s*`, "gi"), "")
      .trim();
  }
  return cleaned;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if a content URL likely needs Bot Framework authentication.
 * URLs hosted on the same domain as the Bot Framework serviceUrl
 * (e.g., smba.trafficmanager.net) require a Bot Connector token.
 * Azure Blob Storage URLs (*.blob.core.windows.net) are pre-authenticated.
 */
function needsBotAuth(contentUrl: string, serviceUrl: string): boolean {
  try {
    const contentHost = new URL(contentUrl).hostname;
    const serviceHost = new URL(serviceUrl).hostname;
    return contentHost === serviceHost;
  } catch {
    return false;
  }
}

/**
 * Extract thread message ID from Teams activity.
 * Teams format: "channelId;messageid=messageId" for thread replies.
 *
 * Prefers replyToId, which on a normal message points at the thread root. For
 * REACTION activities replyToId instead points at the reacted message, so the
 * reaction path uses extractThreadIdFromConversationId directly instead.
 */
function extractThreadId(activity: {
  conversation?: { id?: string };
  replyToId?: string;
}): string | undefined {
  if (activity.replyToId) {
    return activity.replyToId;
  }
  return extractThreadIdFromConversationId(activity.conversation?.id);
}

/** Whether an activity belongs to a team channel, the only Teams surface with reply threads. */
function isTeamsChannel(activity: {
  conversation?: { conversationType?: string };
}): boolean {
  return activity.conversation?.conversationType === "channel";
}

/** The `;messageid=<root>` thread id encoded in a Teams conversation id, if any. */
function extractThreadIdFromConversationId(
  conversationId?: string,
): string | undefined {
  return conversationId?.match(/;messageid=(\d+)/)?.[1];
}

/** A Teams conversation id with any `;messageid=...` thread suffix removed. */
function stripThreadSuffix(conversationId?: string): string | undefined {
  return conversationId?.split(";messageid=")[0] || undefined;
}

/**
 * Extract text from message body and/or Adaptive Card attachments.
 */
function extractMessageText(
  bodyContent?: string,
  attachments?: ChatMessageAttachment[],
): string {
  const parts: string[] = [];

  if (bodyContent) {
    const cleanedBody = stripHtmlTags(bodyContent).trim();
    if (cleanedBody) parts.push(cleanedBody);
  }

  if (attachments?.length) {
    for (const attachment of attachments) {
      if (
        attachment.contentType === "application/vnd.microsoft.card.adaptive" &&
        attachment.content
      ) {
        try {
          const card =
            typeof attachment.content === "string"
              ? JSON.parse(attachment.content)
              : attachment.content;
          const cardText = extractAdaptiveCardText(card);
          if (cardText) parts.push(cardText);
        } catch {
          if (typeof attachment.content === "string") {
            parts.push(attachment.content);
          }
        }
      }
    }
  }

  return parts.join("\n\n");
}

function extractAdaptiveCardText(element: unknown): string {
  if (!element || typeof element !== "object") return "";

  const parts: string[] = [];
  const el = element as Record<string, unknown>;

  if (el.type === "TextBlock" && typeof el.text === "string") {
    parts.push(el.text);
  }

  if (el.type === "FactSet" && Array.isArray(el.facts)) {
    for (const fact of el.facts as { title?: string; value?: string }[]) {
      if (fact.title && fact.value) {
        parts.push(`${fact.title}: ${fact.value}`);
      }
    }
  }

  for (const key of ["body", "items", "columns"] as const) {
    if (Array.isArray(el[key])) {
      for (const item of el[key] as unknown[]) {
        const text = extractAdaptiveCardText(item);
        if (text) parts.push(text);
      }
    }
  }

  return parts.join("\n");
}

function normalizeTeamsId(id: string): string {
  return id.replace(/^28:/, "").toLowerCase();
}

/** Display names of @mentioned participants other than the bot itself. */
function extractMentionedOthers(activity: {
  recipient?: { id?: string };
  entities?: Array<{
    type?: string;
    mentioned?: { id?: string; name?: string };
  }>;
}): string[] {
  const botId = activity.recipient?.id;
  const names = (activity.entities ?? [])
    .filter(
      (e) =>
        e?.type === "mention" &&
        e.mentioned?.id != null &&
        (botId == null ||
          normalizeTeamsId(e.mentioned.id) !== normalizeTeamsId(botId)),
    )
    .map((e) => e.mentioned?.name)
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)];
}

/**
 * SSRF protection: only allow Teams file downloads from known Microsoft domains.
 * Accepts Azure Blob Storage, SharePoint, and the Bot Framework service URL host.
 */
function isAllowedTeamsFileHost(
  contentUrl: string,
  serviceUrl?: string,
): boolean {
  try {
    const hostname = new URL(contentUrl).hostname;
    if (
      hostname.endsWith(".blob.core.windows.net") ||
      hostname.endsWith(".sharepoint.com") ||
      isGraphUrl(contentUrl)
    ) {
      return true;
    }
    // Also allow the Bot Framework serviceUrl host (e.g., smba.trafficmanager.net)
    if (serviceUrl) {
      const serviceHost = new URL(serviceUrl).hostname;
      if (hostname === serviceHost) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";

/** An https URL on the Microsoft Graph host, the only one the Graph token may reach. */
function isGraphUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" && parsed.hostname === "graph.microsoft.com"
    );
  } catch {
    return false;
  }
}

/**
 * Images pasted inline into a message, read from its Graph HTML body. Graph
 * never lists them in `attachments`: each is an `<img>` pointing at the
 * message's hosted content, so thread history would otherwise drop them.
 */
function extractHostedContentImages(html?: string): ChatThreadMessageFile[] {
  if (!html) return [];
  const files: ChatThreadMessageFile[] = [];
  for (const match of html.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/gi)) {
    const url = match[1].replaceAll("&amp;", "&");
    if (isGraphUrl(url) && HOSTED_CONTENT_PATH.test(new URL(url).pathname)) {
      files.push({ url, mimetype: "image/*" });
    }
  }
  return files;
}

const HOSTED_CONTENT_PATH = /\/hostedContents\/[^/]+\/\$value$/;

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid-url";
  }
}

// === Approval cards (Adaptive Card 1.4) ===
// Teams ignores Action `style` (positive/destructive), so the cards rely on
// labels and text color only.

const APPROVAL_ARGS_CONTAINER_ID = "args";
const APPROVAL_ACTIONS_SHOW_ID = "approval-actions-show";
const APPROVAL_ACTIONS_HIDE_ID = "approval-actions-hide";
const APPROVAL_ARG_VALUE_MAX_LENGTH = 500;

/**
 * The approval prompt: the tool, a line saying it waits for review, and its
 * arguments behind a "Show arguments" toggle. With only an OpenAPPA review
 * text (no structured tool), the text is shown in place of tool and arguments.
 */
function buildApprovalRequestCard(
  options: Pick<
    AddApprovalRequestFormOptions,
    | "approvalId"
    | "taskId"
    | "toolName"
    | "toolArgs"
    | "reviewText"
    | "channelId"
    | "threadId"
    | "originalMessage"
  >,
): Record<string, unknown> {
  const isReviewTextFallback = Boolean(options.reviewText);
  const decisionAction = (approved: boolean) => ({
    type: "Action.Submit",
    title: approved ? "Approve" : "Deny",
    data: {
      action: "approvalDecision",
      approvalId: options.approvalId,
      approved,
      taskId: options.taskId,
      toolName: options.toolName,
      // The name the decided card shows; absent when the prompt showed only
      // review text, whose tool is the remedy rather than the reviewed call.
      ...(isReviewTextFallback ? {} : { toolLabel: options.toolName }),
      channelId: options.channelId,
      workspaceId: options.originalMessage.workspaceId,
      threadId: options.threadId,
      originalSenderEmail: options.originalMessage.senderEmail,
      messageId: options.originalMessage.messageId,
    },
  });
  const decisionActions = [decisionAction(true), decisionAction(false)];

  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      text: "Approval required",
      weight: "Bolder",
      wrap: true,
    },
  ];

  if (options.reviewText) {
    body.push(
      {
        type: "TextBlock",
        text: formatApprovalReviewText(options.reviewText),
        wrap: true,
        fontType: "Monospace",
        spacing: "Small",
      },
      { type: "ActionSet", spacing: "Small", actions: decisionActions },
    );
    return approvalCardEnvelope(body, "Approval required");
  }

  body.push(
    {
      type: "TextBlock",
      text: options.toolName,
      fontType: "Monospace",
      wrap: true,
      spacing: "Small",
    },
    {
      type: "TextBlock",
      text: "Review this tool call before it can continue.",
      isSubtle: true,
      wrap: true,
      spacing: "Small",
    },
  );

  const facts = Object.entries(options.toolArgs ?? {}).map(([name, value]) => ({
    title: name,
    value: formatApprovalArgValue(value),
  }));
  if (facts.length === 0) {
    body.push({
      type: "ActionSet",
      spacing: "Small",
      actions: decisionActions,
    });
    return approvalCardEnvelope(body, `Approval required: ${options.toolName}`);
  }

  // Each toggle flips the arguments and swaps which ActionSet is visible, so
  // the button reads "Show arguments" or "Hide arguments" as appropriate.
  const toggleAction = (title: string) => ({
    type: "Action.ToggleVisibility",
    title,
    targetElements: [
      APPROVAL_ARGS_CONTAINER_ID,
      APPROVAL_ACTIONS_SHOW_ID,
      APPROVAL_ACTIONS_HIDE_ID,
    ],
  });
  body.push(
    {
      type: "Container",
      id: APPROVAL_ARGS_CONTAINER_ID,
      isVisible: false,
      spacing: "Small",
      items: [{ type: "FactSet", facts }],
    },
    {
      type: "ActionSet",
      id: APPROVAL_ACTIONS_SHOW_ID,
      spacing: "Small",
      actions: [...decisionActions, toggleAction("Show arguments")],
    },
    {
      type: "ActionSet",
      id: APPROVAL_ACTIONS_HIDE_ID,
      isVisible: false,
      spacing: "Small",
      actions: [...decisionActions, toggleAction("Hide arguments")],
    },
  );
  return approvalCardEnvelope(body, `Approval required: ${options.toolName}`);
}

/**
 * The card that replaces the prompt once someone approves or denies it.
 *
 * @internal exported for tests
 */
export function buildApprovalDecisionCard(params: {
  toolLabel?: string;
  approved: boolean;
  deciderName?: string;
}): Record<string, unknown> {
  const verdict = params.approved ? "Approved" : "Denied";
  const status = params.deciderName
    ? `${verdict} by ${params.deciderName}`
    : verdict;
  const body: Array<Record<string, unknown>> = [];
  if (params.toolLabel) {
    body.push({
      type: "TextBlock",
      text: params.toolLabel,
      fontType: "Monospace",
      wrap: true,
    });
  }
  body.push({
    type: "TextBlock",
    text: status,
    wrap: true,
    spacing: "Small",
    color: params.approved ? "Good" : "Attention",
    ...(params.approved ? { weight: "Bolder" } : {}),
  });
  return approvalCardEnvelope(
    body,
    params.toolLabel ? `${params.toolLabel}: ${status}` : status,
  );
}

function approvalCardEnvelope(
  body: Array<Record<string, unknown>>,
  fallbackText: string,
): Record<string, unknown> {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    fallbackText,
    body,
  };
}

function formatApprovalArgValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > APPROVAL_ARG_VALUE_MAX_LENGTH
    ? `${text.slice(0, APPROVAL_ARG_VALUE_MAX_LENGTH)}… (truncated)`
    : text;
}
