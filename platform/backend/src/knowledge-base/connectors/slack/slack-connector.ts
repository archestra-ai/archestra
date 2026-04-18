import { WebClient } from "@slack/web-api";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  SlackCheckpoint,
  SlackConfig,
} from "@/types";
import { SlackConfigSchema } from "@/types";
import { BaseConnector, extractErrorMessage } from "../base-connector";

const DEFAULT_BATCH_SIZE = 100;

/**
 * Slack knowledge connector.
 *
 * Syncs channel messages, thread replies, and optionally pinned items from
 * a Slack workspace into the knowledge base for RAG retrieval.
 *
 * NOTE: This is a **read-only knowledge ingestion** connector — it is
 * completely separate from the ChatOps Slack provider
 * (`agents/chatops/slack-provider.ts`) which handles two-way agent
 * delivery inside Slack channels.
 *
 * Auth: Bot User OAuth Token (`xoxb-…`) stored in credentials.apiToken.
 * Required bot scopes: channels:history, channels:read, groups:history,
 * groups:read, users:read, pins:read.
 *
 * Checkpoint strategy: per-channel `ts` high-water marks stored as a map
 * (`channelCursors`) so each channel progresses independently.
 */
export class SlackConnector extends BaseConnector {
  type = "slack" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseSlackConfig(config);
    if (!parsed) {
      return { valid: false, error: "Invalid Slack configuration" };
    }

    // Validate channelIds format if provided
    if (parsed.channelIds && parsed.channelIds.length > 0) {
      const invalidIds = parsed.channelIds.filter(
        (id) => !/^[CG][A-Z0-9]+$/.test(id),
      );
      if (invalidIds.length > 0) {
        return {
          valid: false,
          error: `Invalid Slack channel ID(s): ${invalidIds.join(", ")}. Channel IDs start with C or G followed by alphanumeric characters.`,
        };
      }
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    this.log.debug("Testing Slack connection");

    try {
      const client = getSlackClient(params.credentials);

      // Verify token validity and retrieve workspace info
      const authResult = await client.auth.test();
      if (!authResult.ok) {
        return {
          success: false,
          error: `Authentication failed: ${authResult.error ?? "unknown error"}`,
        };
      }

      this.log.debug(
        {
          team: authResult.team,
          user: authResult.user,
          botId: authResult.bot_id,
        },
        "Slack auth.test successful",
      );

      // Verify channel read scopes by attempting to list one channel
      const channelResult = await client.conversations.list({
        types: "public_channel",
        exclude_archived: true,
        limit: 1,
      });

      if (!channelResult.ok) {
        return {
          success: false,
          error: `Channel access failed: ${channelResult.error ?? "unknown error"}. Verify the bot has channels:read scope.`,
        };
      }

      this.log.debug("Slack connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Slack connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseSlackConfig(params.config);
    if (!parsed) return null;

    try {
      const client = getSlackClient(params.credentials);
      const channels = await this.discoverChannels(client, parsed.channelIds);

      // Slack doesn't expose message counts per channel without pagination,
      // so return the channel count as a rough proxy for progress display.
      return channels.length;
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Failed to estimate total items",
      );
      return null;
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseSlackConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Slack configuration");
    }

    const checkpoint = (params.checkpoint as SlackCheckpoint | null) ?? {
      type: "slack" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const skipBotMessages = parsed.skipBotMessages ?? true;
    const includeThreadReplies = parsed.includeThreadReplies ?? true;
    const channelCursors = { ...checkpoint.channelCursors };

    const client = getSlackClient(params.credentials);

    this.log.debug(
      {
        channelIds: parsed.channelIds,
        skipBotMessages,
        includeThreadReplies,
        channelCursorCount: Object.keys(channelCursors).length,
      },
      "Starting Slack sync",
    );

    // Resolve target channels
    const channels = await this.discoverChannels(client, parsed.channelIds);

    this.log.debug(
      { channelCount: channels.length },
      "Discovered Slack channels",
    );

    // User name resolution cache: userId → displayName
    const userNameCache = new Map<string, string>();

    for (let ci = 0; ci < channels.length; ci++) {
      const channel = channels[ci];
      const channelId = channel.id;
      const channelName = channel.name ?? channelId;
      const isLastChannel = ci === channels.length - 1;

      if (!channelId) continue;

      const oldestTs = channelCursors[channelId] ?? "0";
      let cursor: string | undefined;
      let hasMoreMessages = true;
      let maxTs = oldestTs;

      this.log.debug(
        { channelId, channelName, oldestTs },
        "Syncing Slack channel",
      );

      try {
        while (hasMoreMessages) {
          await this.rateLimit();

          const historyResult = await client.conversations.history({
            channel: channelId,
            oldest: oldestTs as string,
            limit: batchSize,
            cursor,
          });

          if (!historyResult.ok) {
            this.log.warn(
              { channelId, error: historyResult.error },
              "Failed to fetch channel history",
            );
            break;
          }

          const messages = historyResult.messages ?? [];
          cursor = historyResult.response_metadata?.next_cursor || undefined;
          hasMoreMessages = historyResult.has_more === true && !!cursor;

          const documents: ConnectorDocument[] = [];

          for (const message of messages) {
            if (!message.ts || !message.text) continue;

            // Filter bot messages if configured
            if (
              skipBotMessages &&
              (message.bot_id || message.subtype === "bot_message")
            ) {
              continue;
            }

            // Skip non-message subtypes (channel_join, channel_leave, etc.)
            if (
              message.subtype &&
              message.subtype !== "bot_message" &&
              message.subtype !== "thread_broadcast"
            ) {
              continue;
            }

            // Track max ts for checkpoint
            if (message.ts > maxTs) {
              maxTs = message.ts;
            }

            // Resolve thread replies if enabled and message has replies
            let threadContent = "";
            if (
              includeThreadReplies &&
              message.reply_count &&
              message.reply_count > 0
            ) {
              threadContent = await this.fetchThreadReplies(
                client,
                channelId,
                message.ts,
                skipBotMessages,
                userNameCache,
              );
            }

            // Resolve author name
            const authorName = message.user
              ? await this.resolveUserName(client, message.user, userNameCache)
              : "Unknown";

            const messageDate = new Date(Number.parseFloat(message.ts) * 1000);

            const contentParts = [message.text];
            if (threadContent) {
              contentParts.push("\n---\n**Thread replies:**");
              contentParts.push(threadContent);
            }

            const doc: ConnectorDocument = {
              id: `slack-${channelId}-${message.ts}`,
              title: `#${channelName} — ${authorName} (${messageDate.toISOString().split("T")[0]})`,
              content: contentParts.join("\n"),
              sourceUrl: undefined,
              metadata: {
                channelId,
                channelName,
                authorId: message.user ?? undefined,
                authorName,
                messageTs: message.ts,
                threadTs: message.thread_ts ?? undefined,
                isThread: Boolean(
                  message.reply_count && message.reply_count > 0,
                ),
                replyCount: message.reply_count ?? 0,
              },
              updatedAt: messageDate,
            };

            documents.push(doc);
          }

          // Update per-channel cursor
          channelCursors[channelId] = maxTs;

          const hasMore = hasMoreMessages || !isLastChannel;

          this.log.debug(
            {
              channelId,
              channelName,
              messageCount: messages.length,
              documentCount: documents.length,
              hasMore,
            },
            "Slack channel batch done",
          );

          yield {
            documents,
            failures: this.flushFailures(),
            checkpoint: {
              type: "slack" as const,
              channelCursors: { ...channelCursors },
              lastSyncedAt: new Date().toISOString(),
            },
            hasMore,
          };
        }
      } catch (error) {
        // Per-channel failure isolation: log the error and continue
        // with the next channel. The cursor for this channel stays at
        // its last successful position.
        const message = extractErrorMessage(error);
        this.log.error(
          { channelId, channelName, error: message },
          "Failed to sync Slack channel, skipping",
        );

        // Yield an empty batch to surface the failure
        yield {
          documents: [],
          failures: [
            {
              itemId: channelId,
              resource: "channel",
              error: message,
            },
          ],
          checkpoint: {
            type: "slack" as const,
            channelCursors: { ...channelCursors },
            lastSyncedAt: new Date().toISOString(),
          },
          hasMore: !isLastChannel,
        };
      }
    }
  }

  // ===== Private methods =====

  /**
   * Discover target channels. If channelIds are specified in config,
   * filter to those; otherwise return all non-archived channels the
   * bot is a member of.
   */
  private async discoverChannels(
    client: WebClient,
    channelIds?: string[],
  ): Promise<Array<{ id: string; name?: string }>> {
    const channels: Array<{ id: string; name?: string }> = [];
    let cursor: string | undefined;

    do {
      await this.rateLimit();

      const result = await client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });

      if (!result.ok) {
        throw new Error(
          `Failed to list channels: ${result.error ?? "unknown"}`,
        );
      }

      for (const ch of result.channels ?? []) {
        if (!ch.id || !ch.is_member) continue;

        // If channelIds filter is set, only include matching channels
        if (channelIds && channelIds.length > 0) {
          if (!channelIds.includes(ch.id)) continue;
        }

        channels.push({ id: ch.id, name: ch.name ?? undefined });
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return channels;
  }

  /**
   * Fetch thread replies for a parent message.
   * Returns formatted reply text with author attribution.
   */
  private async fetchThreadReplies(
    client: WebClient,
    channelId: string,
    threadTs: string,
    skipBotMessages: boolean,
    userNameCache: Map<string, string>,
  ): Promise<string> {
    const replies: string[] = [];

    try {
      await this.rateLimit();

      const result = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 100,
      });

      if (!result.ok || !result.messages) return "";

      // Skip the first message (it's the parent, already processed)
      const replyMessages = result.messages.slice(1);

      for (const reply of replyMessages) {
        if (!reply.text) continue;
        // biome-ignore lint/suspicious/noExplicitAny: Slack SDK MessageElement type doesn't expose subtype/bot_id on all union members
        const replyAny = reply as any;
        if (
          skipBotMessages &&
          (replyAny.bot_id || replyAny.subtype === "bot_message")
        ) {
          continue;
        }

        const replyAuthor = reply.user
          ? await this.resolveUserName(client, reply.user, userNameCache)
          : "Unknown";

        replies.push(`**${replyAuthor}:** ${reply.text}`);
      }
    } catch (error) {
      this.log.warn(
        {
          channelId,
          threadTs,
          error: extractErrorMessage(error),
        },
        "Failed to fetch thread replies, indexing parent message only",
      );
    }

    return replies.join("\n");
  }

  /**
   * Resolve a Slack user ID to a display name.
   * Uses an in-memory cache to avoid redundant API calls.
   */
  private async resolveUserName(
    client: WebClient,
    userId: string,
    cache: Map<string, string>,
  ): Promise<string> {
    const cached = cache.get(userId);
    if (cached) return cached;

    try {
      await this.rateLimit();

      const result = await client.users.info({ user: userId });
      const name =
        result.user?.real_name ||
        result.user?.profile?.display_name ||
        result.user?.name ||
        userId;

      cache.set(userId, name);
      return name;
    } catch (error) {
      this.log.debug(
        { userId, error: extractErrorMessage(error) },
        "Failed to resolve Slack user name",
      );
      cache.set(userId, userId);
      return userId;
    }
  }
}

// ===== Module-level helpers =====

function getSlackClient(credentials: ConnectorCredentials): WebClient {
  return new WebClient(credentials.apiToken);
}

function parseSlackConfig(config: Record<string, unknown>): SlackConfig | null {
  const result = SlackConfigSchema.safeParse({ type: "slack", ...config });
  return result.success ? result.data : null;
}
