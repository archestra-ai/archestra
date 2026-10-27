import { TimeInMs } from "@archestra/shared";
import { WebClient } from "@slack/web-api";
import type { A2AAttachment } from "@/agents/a2a-executor";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import AgentModel from "@/models/agent";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import ChatOpsConfigModel from "@/models/chatops-config";
import DevFeedbackConfigModel from "@/models/dev-feedback-config";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";
import type {
  CreateDevFeedbackCommentBody,
  DevFeedbackAnchor,
  DevFeedbackBot,
  DevFeedbackChannel,
  DevFeedbackComment,
  DevFeedbackReply,
  DevFeedbackSetup,
  DevFeedbackSetupStatus,
} from "@/types/dev-feedback";

/**
 * Internal UI feedback overlay backed by one Slack channel. Each comment is
 * a channel message whose message metadata carries
 * the pin's anchor, its thread holds the discussion, and a ✅ reaction marks
 * it resolved. It posts as one of the chatops Slack bots, so it needs no app
 * of its own. Optional agent dispatch follows confirmed Slack delivery; it
 * never subscribes to bot events.
 */
class DevFeedbackService {
  private client: WebClient | null = null;
  private workspaceUrl: string | null = null;
  private readonly historyCache = new LRUCacheManager<SlackMessage[]>({
    maxSize: 1,
    defaultTtl: 20 * TimeInMs.Second,
  });
  private readonly botNameCache = new LRUCacheManager<string>({
    maxSize: 50,
    defaultTtl: TimeInMs.Hour,
  });
  private readonly userNameCache = new LRUCacheManager<string>({
    maxSize: 500,
    defaultTtl: TimeInMs.Hour,
  });

  /** Turned on per deployment; the bot and channel are then picked in the UI. */
  get isAvailable(): boolean {
    return config.devFeedback.enabled;
  }

  async getSetupStatus(actor: {
    userId: string;
    organizationId: string;
  }): Promise<DevFeedbackSetupStatus> {
    const target = await this.resolveTarget();
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const maySeeAgent =
      target?.agentId &&
      target.organizationId === actor.organizationId &&
      (await ResourcePermissions.allows({
        userId: actor.userId,
        organizationId: actor.organizationId,
        resource: "agent",
        scope: target.agentId,
        action: "use",
      }));
    // SPDX-SnippetEnd
    return {
      configured: target !== null,
      channelName: target?.channelName ?? null,
      ...(maySeeAgent &&
        target?.agentId && {
          agentId: target.agentId,
          agentName: (await AgentModel.findById(target.agentId))?.name ?? null,
        }),
    };
  }

  /** The chatops Slack bots the overlay can post as, named as in Slack. */
  async listBots(): Promise<DevFeedbackBot[]> {
    const bots = await listChatOpsSlackBots();
    return Promise.all(
      bots.map(async (bot) => ({
        id: bot.appId,
        name: await this.getBotName(bot),
      })),
    );
  }

  /**
   * Channels the bot can post to: every public channel (it joins on save)
   * and the private ones it was invited to, which are the only private ones
   * Slack shows it.
   */
  async listChannels(botId: string): Promise<DevFeedbackChannel[]> {
    const client = new WebClient((await findChatOpsSlackBot(botId)).botToken);
    const channels: DevFeedbackChannel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CHANNEL_PAGES; page++) {
      const response = await callSlack(() =>
        client.conversations.list({
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 1000,
          cursor,
        }),
      );
      for (const channel of response.channels ?? []) {
        if (!channel.id || !channel.name) continue;
        channels.push({
          id: channel.id,
          name: channel.name,
          isPrivate: channel.is_private ?? false,
        });
      }
      cursor = response.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return channels.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Saves the choice, joining a public channel the bot is not in yet. */
  async saveSetup(params: {
    botId: string;
    channelId: string;
    agentId?: string | null;
    actor: { userId: string; organizationId: string };
  }): Promise<DevFeedbackSetupStatus> {
    const bot = await findChatOpsSlackBot(params.botId);
    const client = new WebClient(bot.botToken);
    // Slack hides a private channel from a bot that is not in it, so "not
    // found" usually means exactly that.
    const { channel } = await client.conversations
      .info({ channel: params.channelId })
      .catch((error) => {
        if (slackErrorCode(error) !== "channel_not_found") {
          return callSlack(() => Promise.reject(error));
        }
        throw new ApiError(400, PRIVATE_CHANNEL_HINT);
      });
    if (!channel?.id || !channel.name) {
      throw new ApiError(400, PRIVATE_CHANNEL_HINT);
    }
    if (!channel.is_member) {
      if (channel.is_private) throw new ApiError(400, PRIVATE_CHANNEL_HINT);
      const channelId = channel.id;
      await callSlack(() => client.conversations.join({ channel: channelId }));
    }
    let dispatch: Partial<DevFeedbackSetup> = {};
    if (params.agentId) {
      const agent = await AgentModel.findById(params.agentId);
      if (
        !agent ||
        agent.organizationId !== params.actor.organizationId ||
        agent.agentType !== "agent" ||
        !resolveAgentRuntime(agent)
      )
        throw new ApiError(
          400,
          "Choose an Agent with Agent Runtime in this organization.",
        );
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissions.require({
        userId: params.actor.userId,
        organizationId: params.actor.organizationId,
        resource: "agent",
        scope: agent.id,
        action: "use",
      });
      // SPDX-SnippetEnd
      const identity = await client.auth.test();
      if (!identity.team_id)
        throw new ApiError(
          409,
          "Slack did not identify the posting workspace.",
        );
      const pinned = (await ChatOpsConfigModel.getSlackAgentBots()).find(
        (candidate) => candidate.appId === params.botId,
      );
      if (pinned && pinned.agentId !== agent.id)
        throw new ApiError(
          400,
          "Choose the Agent that owns the selected Slack bot.",
        );
      const binding = await ChatOpsChannelBindingModel.findByChannel({
        provider: "slack",
        channelId: channel.id,
        workspaceId: identity.team_id,
      });
      if (
        !binding ||
        binding.organizationId !== params.actor.organizationId ||
        binding.isDm ||
        (!pinned && binding.agentId !== agent.id)
      )
        throw new ApiError(
          409,
          "Assign this Slack channel to the selected Agent before enabling automatic feedback runs.",
        );
      dispatch = {
        organizationId: params.actor.organizationId,
        agentId: agent.id,
        workspaceId: identity.team_id,
        bindingId: binding.id,
        ...(pinned && { pinnedAgentId: agent.id }),
      };
    }
    await DevFeedbackConfigModel.save({
      botId: bot.appId,
      channelId: channel.id,
      channelName: channel.name,
      ...dispatch,
    });
    this.historyCache.delete(channel.id);
    return {
      configured: true,
      channelName: channel.name,
      ...(params.agentId && {
        agentId: params.agentId,
        agentName: (await AgentModel.findById(params.agentId))?.name ?? null,
      }),
    };
  }

  /** Open comments pinned on a route pattern, oldest first. */
  async listComments(route: string): Promise<DevFeedbackComment[]> {
    const target = await this.resolveTarget();
    if (!target) throw new ApiError(409, "UI feedback is not set up yet");
    const channel = target.channelId;
    const messages = await this.getChannelHistory();
    const workspaceUrl = await this.getWorkspaceUrl();
    const comments = messages
      .filter(
        (message) =>
          message.metadata?.event_type === COMMENT_EVENT_TYPE &&
          message.metadata.event_payload?.route === route &&
          !isResolved(message),
      )
      .map((message) => toComment({ message, workspaceUrl, channel }))
      .filter((comment): comment is DevFeedbackComment => comment !== null)
      .reverse();
    return comments;
  }

  async createComment(params: {
    body: CreateDevFeedbackCommentBody;
    authorName: string;
    actor: { userId: string; organizationId: string };
  }): Promise<DevFeedbackComment> {
    const { body, authorName, actor } = params;
    const target = await this.resolveTarget();
    if (!target) throw new ApiError(409, "UI feedback is not set up yet");
    if (target.agentId && target.organizationId !== actor.organizationId)
      throw new ApiError(
        403,
        "This feedback target belongs to another organization.",
      );
    const client = new WebClient(target.token);
    const screenshotFileId = body.screenshot
      ? await this.uploadUnsharedFile({
          file: body.screenshot,
          name: "screenshot",
          client,
        })
      : null;
    const payload: CommentPayload = {
      ...feedbackAnchor(body),
      text: body.text,
      authorName,
      url: onThisDeployment(body.url),
      ...(screenshotFileId ? { screenshotFileId } : {}),
    };
    const posted = await this.postComment(payload, {
      client,
      channel: target.channelId,
    });
    const rootTs = posted.ts;
    this.historyCache.delete(target.channelId);
    const comment: DevFeedbackComment = {
      ...feedbackAnchor(body),
      id: rootTs,
      text: body.text,
      authorName,
      replyCount: 0,
      permalink: null,
      createdAt: tsToIso(rootTs),
    };
    // Once Slack confirms delivery, later failures must not invite a replacement post.
    try {
      comment.permalink = buildPermalink({
        workspaceUrl: await this.workspaceUrlFor(client),
        channel: target.channelId,
        ts: rootTs,
      });
      await client.chat
        .update({
          ...renderComment({ ts: rootTs, payload: posted.payload }),
          channel: target.channelId,
          ts: rootTs,
        })
        .catch((error) =>
          logger.warn(
            { err: error },
            "[DevFeedback] Failed to add comment link",
          ),
        );
      let clipOutcome: "uploaded" | "unavailable" | "absent" = body.clip
        ? "unavailable"
        : "absent";
      if (body.clip) {
        try {
          await client.filesUploadV2({
            channel_id: target.channelId,
            thread_ts: rootTs,
            file_uploads: [
              {
                file: Buffer.from(body.clip.base64, "base64"),
                filename: `clip.${extensionFor(body.clip.mimeType)}`,
              },
            ],
          });
          clipOutcome = "uploaded";
        } catch (error) {
          logger.warn({ err: error }, "[DevFeedback] Failed to upload clip");
        }
      }
      if (target.agentId) {
        const result = await chatOpsManager.dispatchFeedbackReport({
          report: {
            id: rootTs,
            rootTs,
            organizationId: actor.organizationId,
            actorUserId: actor.userId,
            authorName,
            body: { ...body, url: payload.url ?? body.url },
            target: withoutToken(target),
            permalink: comment.permalink,
            createdAt: new Date(comment.createdAt),
            media: {
              screenshot: posted.payload.screenshotFileId
                ? "uploaded"
                : body.screenshot
                  ? "unavailable"
                  : "absent",
              clip: clipOutcome,
            },
          },
          attachments: feedbackAttachments(body),
        });
        if (!result.success || !result.taskId)
          throw new Error(result.error || "Agent task was not created");
        comment.dispatch = {
          status: "started",
          runId: result.taskId,
          message: null,
        };
      }
    } catch (error) {
      logger.warn(
        { err: error, rootTs },
        "[DevFeedback] Report posted; Agent startup failed",
      );
      if (target.agentId)
        comment.dispatch = {
          status: "failed",
          runId: null,
          message:
            "Posted to Slack, but Agent startup could not be confirmed. Check Agent access, credentials and feedback setup.",
        };
    }
    return comment;
  }

  private async workspaceUrlFor(client: WebClient): Promise<string | null> {
    try {
      return (await client.auth.test()).url ?? null;
    } catch {
      return null;
    }
  }

  async listReplies(commentId: string): Promise<DevFeedbackReply[]> {
    const { client, channel } = await this.getTarget();
    const response = await client.conversations.replies({
      channel,
      ts: commentId,
      include_all_metadata: true,
      limit: 200,
    });
    const messages = (response.messages ?? []) as SlackMessage[];
    // Only comment threads: the channel may hold other conversations.
    assertIsComment(messages.find((message) => message.ts === commentId));
    const replies = messages.filter(
      (message) => message.ts !== commentId && message.text,
    );
    return Promise.all(
      replies.map(async (message) => ({
        id: message.ts ?? "",
        authorName: await this.resolveAuthorName(message),
        text:
          message.metadata?.event_type === REPLY_EVENT_TYPE
            ? String(message.metadata.event_payload?.text ?? "")
            : (message.text ?? ""),
        createdAt: tsToIso(message.ts ?? "0"),
      })),
    );
  }

  async createReply(params: {
    commentId: string;
    text: string;
    authorName: string;
  }): Promise<DevFeedbackReply> {
    const { commentId, text, authorName } = params;
    const { client, channel } = await this.getTarget();
    assertIsComment(await this.findMessage(commentId));
    const posted = await client.chat.postMessage({
      channel,
      thread_ts: commentId,
      text: `*${escapeMrkdwn(authorName)}:* ${escapeMrkdwn(text)}`,
      metadata: {
        event_type: REPLY_EVENT_TYPE,
        event_payload: { text, authorName },
      },
    });
    this.historyCache.delete((await this.getTarget()).channel);
    const ts = posted.ts ?? "0";
    return { id: ts, authorName, text, createdAt: tsToIso(ts) };
  }

  /**
   * Marks the comment resolved by rewriting the bot's own message, which
   * needs no scope beyond posting. A ✅ reaction added in Slack counts too.
   */
  async resolveComment(params: {
    commentId: string;
    resolvedBy: string;
  }): Promise<void> {
    const { commentId, resolvedBy } = params;
    const message = await this.findMessage(commentId);
    const payload = assertIsComment(message);
    if (message && isResolved(message)) return;
    await this.updateComment({
      ts: commentId,
      payload: { ...payload, resolvedBy },
    });
    this.historyCache.delete((await this.getTarget()).channel);
  }

  // ===

  /** The channel message with this ts, if any. */
  private async findMessage(ts: string): Promise<SlackMessage | undefined> {
    const { client, channel } = await this.getTarget();
    const response = await client.conversations.replies({
      channel,
      ts,
      include_all_metadata: true,
      limit: 1,
    });
    return ((response.messages ?? []) as SlackMessage[]).find(
      (candidate) => candidate.ts === ts,
    );
  }

  /**
   * Uploads a file without sharing it anywhere, so a message can show it in
   * an image block. Returns null when the upload fails: the comment still
   * posts, only without its picture.
   */
  private async uploadUnsharedFile(params: {
    file: { mimeType: string; base64: string };
    name: string;
    client?: WebClient;
  }): Promise<string | null> {
    const client = params.client ?? (await this.getTarget()).client;
    const bytes = Buffer.from(params.file.base64, "base64");
    try {
      const { file_id: fileId, upload_url: uploadUrl } =
        await client.files.getUploadURLExternal({
          filename: `${params.name}.${extensionFor(params.file.mimeType)}`,
          length: bytes.length,
        });
      if (!fileId || !uploadUrl) return null;
      const uploaded = await fetch(uploadUrl, { method: "POST", body: bytes });
      if (!uploaded.ok) throw new Error(`upload returned ${uploaded.status}`);
      await client.files.completeUploadExternal({
        files: [{ id: fileId, title: params.name }],
      });
      return fileId;
    } catch (error) {
      logger.warn({ err: error }, "[DevFeedback] Failed to upload screenshot");
      return null;
    }
  }

  /**
   * Posts the comment, with the screenshot inline when there is one. Slack
   * rejects an image block until it has processed the upload, which takes
   * about a second, so that rejection is retried; if the image never
   * becomes usable the comment posts as text. Returns the payload as posted.
   */
  private async postComment(
    payload: CommentPayload,
    target: { client: WebClient; channel: string },
  ): Promise<{ ts: string; payload: CommentPayload }> {
    const { client, channel } = target;
    if (payload.screenshotFileId) {
      for (let attempt = 1; attempt <= IMAGE_POST_ATTEMPTS; attempt++) {
        try {
          const postArgs: Parameters<WebClient["chat"]["postMessage"]>[0] = {
            ...renderComment({ payload, ts: null }),
            channel,
            unfurl_links: false,
            unfurl_media: false,
          };
          const posted = await client.chat.postMessage(postArgs);
          if (posted.ts) return { ts: posted.ts, payload };
          throw new Error("Slack did not return a message ts");
        } catch (error) {
          if (slackErrorCode(error) !== "invalid_blocks") throw error;
          await sleep(IMAGE_RETRY_DELAY_MS);
        }
      }
      logger.warn(
        "[DevFeedback] Screenshot was not ready; posting the comment as text",
      );
    }
    const { screenshotFileId: _, ...textOnly } = payload;
    const postArgs: Parameters<WebClient["chat"]["postMessage"]>[0] = {
      ...renderComment({ payload: textOnly, ts: null }),
      channel,
      unfurl_links: false,
      unfurl_media: false,
    };
    const posted = await client.chat.postMessage(postArgs);
    if (!posted.ts) throw new Error("Slack did not return a message ts");
    return { ts: posted.ts, payload: textOnly };
  }

  /** Re-renders a posted comment from its payload, e.g. once resolved. */
  private async updateComment(params: {
    ts: string;
    payload: CommentPayload;
  }): Promise<void> {
    await (await this.getTarget()).client.chat.update({
      ...renderComment(params),
      channel: (await this.getTarget()).channel,
      ts: params.ts,
    });
  }

  /** Where comments go; 409 until a bot and channel are picked. */
  private async getTarget(): Promise<{ client: WebClient; channel: string }> {
    const target = await this.resolveTarget();
    if (!target) throw new ApiError(409, "UI feedback is not set up yet");
    if (this.client?.token !== target.token) {
      this.client = new WebClient(target.token);
    }
    return { client: this.client, channel: target.channelId };
  }

  /**
   * The saved channel and the current token of the saved bot. The token is
   * looked up in the chatops config each time rather than copied, so a bot
   * reinstall is picked up. Null when unset, or when the bot has since gone.
   */
  private async resolveTarget(): Promise<ResolvedTarget | null> {
    const setup = await DevFeedbackConfigModel.get();
    if (!setup) return null;
    const bot = (await listChatOpsSlackBots()).find(
      ({ appId }) => appId === setup.botId,
    );
    if (!bot) return null;
    return {
      ...setup,
      token: bot.botToken,
    };
  }

  private async getBotName(bot: { appId: string; botToken: string }) {
    const cached = this.botNameCache.get(bot.appId);
    if (cached) return cached;
    try {
      const response = await new WebClient(bot.botToken).auth.test();
      const name = response.user ?? bot.appId;
      this.botNameCache.set(bot.appId, name);
      return name;
    } catch {
      return bot.appId;
    }
  }

  /**
   * Recent channel messages. Bounded on purpose: the channel is a team
   * scratchpad, and a pin older than the last 200 messages is stale anyway.
   */
  private async getChannelHistory(): Promise<SlackMessage[]> {
    const { client, channel } = await this.getTarget();
    const cached = this.historyCache.get(channel);
    if (cached) return cached;
    const response = await client.conversations.history({
      channel,
      include_all_metadata: true,
      limit: 200,
    });
    const messages = (response.messages ?? []) as SlackMessage[];
    this.historyCache.set(channel, messages);
    return messages;
  }

  private async getWorkspaceUrl(): Promise<string | null> {
    if (this.workspaceUrl) return this.workspaceUrl;
    try {
      const response = await (await this.getTarget()).client.auth.test();
      this.workspaceUrl = response.url ?? null;
    } catch (error) {
      logger.warn({ err: error }, "[DevFeedback] auth.test failed");
    }
    return this.workspaceUrl;
  }

  private async resolveAuthorName(message: SlackMessage): Promise<string> {
    const fromMetadata = message.metadata?.event_payload?.authorName;
    if (typeof fromMetadata === "string") return fromMetadata;
    if (!message.user) return "Slack";
    const cached = this.userNameCache.get(message.user);
    if (cached) return cached;
    try {
      const response = await (await this.getTarget()).client.users.info({
        user: message.user,
      });
      const name =
        response.user?.profile?.display_name ||
        response.user?.real_name ||
        message.user;
      this.userNameCache.set(message.user, name);
      return name;
    } catch {
      return message.user;
    }
  }
}

export const devFeedbackService = new DevFeedbackService();

// ===

const COMMENT_EVENT_TYPE = "archestra_dev_feedback_comment";
const REPLY_EVENT_TYPE = "archestra_dev_feedback_reply";
const RESOLVED_REACTION = "white_check_mark";
const PRIVATE_CHANNEL_HINT =
  "The bot cannot see this channel. For a private channel, invite the bot first.";
/** Up to 5,000 channels; a workspace with more can still pick by search. */
const MAX_CHANNEL_PAGES = 5;

type ResolvedTarget = DevFeedbackSetup & { token: string };

/** Every enabled chatops Slack bot: the main app and the per-agent apps. */
async function listChatOpsSlackBots(): Promise<
  { appId: string; botToken: string }[]
> {
  const [main, agentBots] = await Promise.all([
    ChatOpsConfigModel.getSlackConfig(),
    ChatOpsConfigModel.getSlackAgentBots(),
  ]);
  return [main, ...agentBots].flatMap((bot) =>
    bot?.enabled && bot.botToken && bot.appId
      ? [{ appId: bot.appId, botToken: bot.botToken }]
      : [],
  );
}

async function findChatOpsSlackBot(
  botId: string,
): Promise<{ appId: string; botToken: string }> {
  const bot = (await listChatOpsSlackBots()).find(
    ({ appId }) => appId === botId,
  );
  if (!bot) throw new ApiError(404, "Slack bot not found");
  return bot;
}

/** Turns a Slack API refusal into a 400 that names Slack's reason. */
async function callSlack<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const code = slackErrorCode(error);
    if (code) throw new ApiError(400, `Slack refused the request: ${code}`);
    throw error;
  }
}
const IMAGE_POST_ATTEMPTS = 6;
const IMAGE_RETRY_DELAY_MS = 750;
/** URL hash the overlay reads to open one comment; keep in sync with it. */
const COMMENT_LINK_HASH_KEY = "dev-feedback-comment";

/**
 * Everything a comment message is rendered from. It rides along as the
 * message metadata, so the message can be re-rendered (to add its link, or
 * to mark it resolved) without parsing what Slack sends back.
 */
type CommentPayload = DevFeedbackAnchor & {
  text: string;
  authorName: string;
  url?: string;
  screenshotFileId?: string;
  resolvedBy?: string;
};

type SlackMessage = {
  ts?: string;
  text?: string;
  user?: string;
  reply_count?: number;
  reactions?: { name?: string }[];
  metadata?: {
    event_type?: string;
    event_payload?: Record<string, unknown>;
  };
};

function toComment(params: {
  message: SlackMessage;
  workspaceUrl: string | null;
  channel: string;
}): DevFeedbackComment | null {
  const { message, workspaceUrl, channel } = params;
  const payload = message.metadata?.event_payload;
  if (!payload || !message.ts) return null;
  return {
    id: message.ts,
    route: String(payload.route ?? ""),
    selector: String(payload.selector ?? ""),
    label: String(payload.label ?? ""),
    elementX: Number(payload.elementX ?? 0.5),
    elementY: Number(payload.elementY ?? 0.5),
    viewportX: Number(payload.viewportX ?? 0.5),
    viewportY: Number(payload.viewportY ?? 0.5),
    text: String(payload.text ?? ""),
    authorName: String(payload.authorName ?? ""),
    replyCount: message.reply_count ?? 0,
    permalink: buildPermalink({ workspaceUrl, channel, ts: message.ts }),
    createdAt: tsToIso(message.ts),
  };
}

/** 404 unless the message is a feedback comment; returns its payload. */
function assertIsComment(message: SlackMessage | undefined): CommentPayload {
  if (message?.metadata?.event_type !== COMMENT_EVENT_TYPE) {
    throw new ApiError(404, "Comment not found");
  }
  return message.metadata.event_payload as CommentPayload;
}

function isResolved(message: SlackMessage): boolean {
  return (
    typeof message.metadata?.event_payload?.resolvedBy === "string" ||
    (message.reactions ?? []).some(
      (reaction) => reaction.name === RESOLVED_REACTION,
    )
  );
}

/**
 * The message for a comment. With a screenshot, the body is the author line
 * and the picture, which already shows the comment; the comment text stays
 * in the fallback text that notifications and search use. Once the message
 * ts is known, the page link opens this exact comment.
 */
function renderComment(params: { payload: CommentPayload; ts: string | null }) {
  const { payload, ts } = params;
  const pageUrl =
    payload.url && ts ? withCommentHash({ url: payload.url, ts }) : payload.url;
  const route = escapeMrkdwn(payload.route);
  const header = [
    payload.resolvedBy
      ? `:white_check_mark: Resolved by ${escapeMrkdwn(payload.resolvedBy)} · `
      : "",
    `*${escapeMrkdwn(payload.authorName)}* on `,
    pageUrl ? `<${toSlackUrl(pageUrl)}|${route}>` : route,
  ].join("");
  const quoted = escapeMrkdwn(payload.text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const message = {
    text: `${header}\n${quoted}`,
    metadata: { event_type: COMMENT_EVENT_TYPE, event_payload: payload },
  };
  if (!payload.screenshotFileId) return message;
  return {
    ...message,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: header } },
      {
        type: "image",
        slack_file: { id: payload.screenshotFileId },
        alt_text: payload.text.slice(0, 2000),
      },
    ],
  };
}

function withCommentHash(params: { url: string; ts: string }): string {
  try {
    const url = new URL(params.url);
    url.hash = `${COMMENT_LINK_HASH_KEY}=${params.ts}`;
    return url.toString();
  } catch {
    return params.url;
  }
}

/**
 * The page link in Slack always points at this deployment: only the path and
 * query come from the browser, so a direct API call can't link elsewhere.
 */
function onThisDeployment(url: string): string | undefined {
  try {
    const { pathname, search } = new URL(url);
    return new URL(`${pathname}${search}`, config.frontendBaseUrl).toString();
  } catch {
    return undefined;
  }
}

/** Keeps a URL from breaking out of Slack's `<url|label>` link syntax. */
function toSlackUrl(url: string): string {
  return url.replaceAll("|", "%7C").replaceAll(">", "%3E");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPermalink(params: {
  workspaceUrl: string | null;
  channel: string;
  ts: string;
}): string | null {
  const { workspaceUrl, channel, ts } = params;
  if (!workspaceUrl) return null;
  const base = workspaceUrl.endsWith("/") ? workspaceUrl : `${workspaceUrl}/`;
  return `${base}archives/${channel}/p${ts.replace(".", "")}`;
}

function tsToIso(ts: string): string {
  return new Date(Number.parseFloat(ts) * 1000).toISOString();
}

function extensionFor(mimeType: string): string {
  return mimeType.split("/")[1] === "jpeg" ? "jpg" : mimeType.split("/")[1];
}

function escapeMrkdwn(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function slackErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const data = (error as { data?: { error?: unknown } }).data;
  return typeof data?.error === "string" ? data.error : undefined;
}

function feedbackAnchor(body: CreateDevFeedbackCommentBody): DevFeedbackAnchor {
  return {
    route: body.route,
    selector: body.selector,
    label: body.label,
    elementX: body.elementX,
    elementY: body.elementY,
    viewportX: body.viewportX,
    viewportY: body.viewportY,
  };
}

function withoutToken(target: ResolvedTarget): DevFeedbackSetup {
  const { token: _token, ...saved } = target;
  return saved;
}

function feedbackAttachments(
  body: CreateDevFeedbackCommentBody,
): A2AAttachment[] {
  const attachments: A2AAttachment[] = [];
  if (body.screenshot)
    attachments.push({
      name:
        body.screenshot.mimeType === "image/png"
          ? "screenshot.png"
          : "screenshot.jpg",
      contentType: body.screenshot.mimeType,
      contentBase64: body.screenshot.base64,
    });
  if (body.clip)
    attachments.push({
      name: body.clip.mimeType === "video/mp4" ? "clip.mp4" : "clip.webm",
      contentType: body.clip.mimeType,
      contentBase64: body.clip.base64,
    });
  return attachments;
}
