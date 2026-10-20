import { TimeInMs } from "@archestra/shared";
import { WebClient } from "@slack/web-api";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import ChatOpsConfigModel from "@/models/chatops-config";
import DevFeedbackConfigModel from "@/models/dev-feedback-config";
import { ApiError } from "@/types";
import type {
  CreateDevFeedbackCommentBody,
  DevFeedbackAnchor,
  DevFeedbackBot,
  DevFeedbackChannel,
  DevFeedbackComment,
  DevFeedbackReply,
  DevFeedbackSetupStatus,
} from "@/types/dev-feedback";

/**
 * Internal UI feedback overlay backed by one Slack channel. Slack is the only
 * storage: each comment is a channel message whose message metadata carries
 * the pin's anchor, its thread holds the discussion, and a ✅ reaction marks
 * it resolved. It posts as one of the chatops Slack bots, so it needs no app
 * of its own; the only thing stored is which bot and channel were picked.
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

  async getSetupStatus(): Promise<DevFeedbackSetupStatus> {
    const target = await this.resolveTarget();
    return {
      configured: target !== null,
      channelName: target?.channelName ?? null,
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
    await DevFeedbackConfigModel.save({
      botId: bot.appId,
      channelId: channel.id,
      channelName: channel.name,
    });
    this.historyCache.delete(channel.id);
    return { configured: true, channelName: channel.name };
  }

  /** Open comments pinned on a route pattern, oldest first. */
  async listComments(route: string): Promise<DevFeedbackComment[]> {
    const { channel } = await this.getTarget();
    const messages = await this.getChannelHistory();
    const workspaceUrl = await this.getWorkspaceUrl();
    return messages
      .filter(
        (message) =>
          message.metadata?.event_type === COMMENT_EVENT_TYPE &&
          message.metadata.event_payload?.route === route &&
          !isResolved(message),
      )
      .map((message) => toComment({ message, workspaceUrl, channel }))
      .filter((comment): comment is DevFeedbackComment => comment !== null)
      .reverse();
  }

  async createComment(params: {
    body: CreateDevFeedbackCommentBody;
    authorName: string;
  }): Promise<DevFeedbackComment> {
    const { body, authorName } = params;
    const { client } = await this.getTarget();
    const channel = (await this.getTarget()).channel;
    const anchor: DevFeedbackAnchor = {
      route: body.route,
      selector: body.selector,
      label: body.label,
      elementX: body.elementX,
      elementY: body.elementY,
      viewportX: body.viewportX,
      viewportY: body.viewportY,
    };

    const screenshotFileId = body.screenshot
      ? await this.uploadUnsharedFile({
          file: body.screenshot,
          name: "screenshot",
        })
      : null;
    const payload: CommentPayload = {
      ...anchor,
      text: body.text,
      authorName,
      url: body.url,
      ...(screenshotFileId ? { screenshotFileId } : {}),
    };
    const { ts, payload: posted } = await this.postComment(payload);
    // The link that opens this exact comment needs the message ts, which
    // exists only once the message does.
    await this.updateComment({ ts, payload: posted }).catch((error) =>
      logger.warn({ err: error }, "[DevFeedback] Failed to add comment link"),
    );

    // The clip goes into the thread: Slack shows only images inline in a
    // message, and an upload posted on its own cannot carry the metadata the
    // overlay reads pins from.
    if (body.clip) {
      try {
        await client.filesUploadV2({
          channel_id: channel,
          thread_ts: ts,
          file_uploads: [
            {
              file: Buffer.from(body.clip.base64, "base64"),
              filename: `clip.${extensionFor(body.clip.mimeType)}`,
            },
          ],
        });
      } catch (error) {
        // The comment is already posted; a failed upload must not lose it.
        logger.warn({ err: error }, "[DevFeedback] Failed to upload clip");
      }
    }

    this.historyCache.delete((await this.getTarget()).channel);
    const workspaceUrl = await this.getWorkspaceUrl();
    return {
      ...anchor,
      id: ts,
      text: body.text,
      authorName,
      replyCount: 0,
      permalink: buildPermalink({ workspaceUrl, channel, ts }),
      createdAt: tsToIso(ts),
    };
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
  }): Promise<string | null> {
    const { client } = await this.getTarget();
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
  ): Promise<{ ts: string; payload: CommentPayload }> {
    const { client } = await this.getTarget();
    if (payload.screenshotFileId) {
      for (let attempt = 1; attempt <= IMAGE_POST_ATTEMPTS; attempt++) {
        try {
          const posted = await client.chat.postMessage({
            ...renderComment({ payload, ts: null }),
            channel: (await this.getTarget()).channel,
            unfurl_links: false,
            unfurl_media: false,
          });
          if (posted.ts) return { ts: posted.ts, payload };
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
    const posted = await client.chat.postMessage({
      ...renderComment({ payload: textOnly, ts: null }),
      channel: (await this.getTarget()).channel,
      unfurl_links: false,
      unfurl_media: false,
    });
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
      token: bot.botToken,
      channelId: setup.channelId,
      channelName: setup.channelName,
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

type ResolvedTarget = { token: string; channelId: string; channelName: string };

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
