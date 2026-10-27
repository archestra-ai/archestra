import { HttpResponse, http } from "msw";
import config from "@/config";
import ChatOpsConfigModel from "@/models/chatops-config";
import DevFeedbackConfigModel from "@/models/dev-feedback-config";

/**
 * One in-memory Slack channel for msw: messages with metadata, threads,
 * reactions, users and the three-step external file upload. Enough of the Web
 * API for `@slack/web-api` to run unmodified against it.
 */
export class FakeSlack {
  readonly messages: FakeSlackMessage[] = [];
  readonly uploads: {
    id: string;
    threadTs: string;
    filenames: string[];
  }[] = [];
  readonly users = new Map<string, string>();
  readonly workspaceUrl = "https://acme.slack.com/";
  /**
   * How many posts that show an uploaded image Slack rejects first, as it
   * does while the upload is still being processed.
   */
  imageNotReadyPosts = 0;
  /** Channels the workspace has; the message channel is the first. */
  readonly channels: FakeSlackChannel[];
  readonly botName = "feedback-bot";
  private nextTs = 1_729_426_800;
  private pendingFiles = new Map<string, string>();

  constructor(readonly channel: string) {
    this.channels = [
      { id: channel, name: "ui-feedback", isPrivate: false, isMember: true },
    ];
  }

  /** Turns the overlay on with a chatops Slack bot (app `A1`), unpicked. */
  async connectChatOpsBot() {
    config.devFeedback.enabled = true;
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: "xoxb-test",
      signingSecret: "",
      appId: "A1",
    });
  }

  /** As if an admin had already picked this bot and this channel. */
  async configureAsDevFeedbackChannel() {
    await this.connectChatOpsBot();
    await DevFeedbackConfigModel.save({
      botId: "A1",
      channelId: this.channel,
      channelName: "ui-feedback",
    });
  }

  /** Add a message as if someone posted it in Slack directly. */
  addMessage(message: Omit<FakeSlackMessage, "ts"> & { ts?: string }) {
    const added = { ...message, ts: message.ts ?? this.mintTs() };
    this.messages.push(added);
    return added;
  }

  handlers() {
    return [
      this.method("auth.test", () => ({
        url: this.workspaceUrl,
        user: this.botName,
        team_id: "T1",
        bot_id: "B1",
      })),
      this.method("conversations.list", () => ({
        channels: this.channels
          .filter((channel) => !channel.isPrivate || channel.isMember)
          .map((channel) => this.toWireChannel(channel)),
        response_metadata: { next_cursor: "" },
      })),
      this.method("conversations.info", (params) => {
        const channel = this.channels.find(
          (candidate) => candidate.id === params.get("channel"),
        );
        if (!channel || (channel.isPrivate && !channel.isMember)) {
          return { ok: false, error: "channel_not_found" };
        }
        return { channel: this.toWireChannel(channel) };
      }),
      this.method("conversations.join", (params) => {
        const channel = this.channels.find(
          (candidate) => candidate.id === params.get("channel"),
        );
        if (!channel) return { ok: false, error: "channel_not_found" };
        channel.isMember = true;
        return { channel: this.toWireChannel(channel) };
      }),
      this.method("chat.postMessage", (params) => {
        const metadata = params.get("metadata");
        const blocks = params.get("blocks");
        if (blocks?.includes("slack_file") && this.imageNotReadyPosts > 0) {
          this.imageNotReadyPosts -= 1;
          return { ok: false, error: "invalid_blocks" };
        }
        const message = this.addMessage({
          text: params.get("text") ?? "",
          blocks: blocks ? JSON.parse(blocks) : undefined,
          threadTs: params.get("thread_ts") ?? undefined,
          botId: "B1",
          metadata: metadata ? JSON.parse(metadata) : undefined,
        });
        return { ts: message.ts, channel: this.channel };
      }),
      this.method("chat.update", (params) => {
        const message = this.messages.find(
          (candidate) => candidate.ts === params.get("ts"),
        );
        if (!message) return { ok: false, error: "message_not_found" };
        const metadata = params.get("metadata");
        const blocks = params.get("blocks");
        message.text = params.get("text") ?? message.text;
        message.blocks = blocks ? JSON.parse(blocks) : undefined;
        if (metadata) message.metadata = JSON.parse(metadata);
        return { ts: message.ts, channel: this.channel };
      }),
      this.method("conversations.history", () => ({
        messages: this.messages
          .filter((message) => !message.threadTs)
          .reverse()
          .map((message) => ({
            ...this.toWire(message),
            reply_count: this.messages.filter(
              (reply) => reply.threadTs === message.ts,
            ).length,
          })),
      })),
      this.method("conversations.replies", (params) => {
        const ts = params.get("ts");
        return {
          messages: this.messages
            .filter((message) => message.ts === ts || message.threadTs === ts)
            .map((message) => this.toWire(message)),
        };
      }),
      this.method("reactions.add", (params) => {
        const message = this.messages.find(
          (candidate) => candidate.ts === params.get("timestamp"),
        );
        const name = params.get("name") ?? "";
        if (!message) return { ok: false, error: "message_not_found" };
        if (message.reactions?.includes(name)) {
          return { ok: false, error: "already_reacted" };
        }
        message.reactions = [...(message.reactions ?? []), name];
        return {};
      }),
      this.method("users.info", (params) => {
        const id = params.get("user") ?? "";
        const name = this.users.get(id);
        if (!name) return { ok: false, error: "user_not_found" };
        return { user: { id, real_name: name, profile: { display_name: "" } } };
      }),
      this.method("files.getUploadURLExternal", (params) => {
        const id = `F${this.pendingFiles.size + this.uploads.length + 1}`;
        this.pendingFiles.set(id, params.get("filename") ?? "");
        return {
          file_id: id,
          upload_url: `https://files.slack.com/upload/v1/${id}`,
        };
      }),
      http.post("https://files.slack.com/upload/v1/:id", () =>
        HttpResponse.text("OK"),
      ),
      this.method("files.completeUploadExternal", (params) => {
        const files = JSON.parse(params.get("files") ?? "[]") as {
          id: string;
        }[];
        this.uploads.push({
          id: files[0]?.id ?? "",
          threadTs: params.get("thread_ts") ?? "",
          filenames: files.map((file) => this.pendingFiles.get(file.id) ?? ""),
        });
        return { files };
      }),
    ];
  }

  private method(
    name: string,
    respond: (params: URLSearchParams) => Record<string, unknown>,
  ) {
    return http.post(`https://slack.com/api/${name}`, async ({ request }) => {
      const params = new URLSearchParams(await request.text());
      return HttpResponse.json({ ok: true, ...respond(params) });
    });
  }

  private toWire(message: FakeSlackMessage) {
    return {
      ts: message.ts,
      text: message.text,
      blocks: message.blocks,
      thread_ts: message.threadTs,
      user: message.user,
      bot_id: message.botId,
      metadata: message.metadata,
      reactions: message.reactions?.map((name) => ({ name, count: 1 })),
    };
  }

  private toWireChannel(channel: FakeSlackChannel) {
    return {
      id: channel.id,
      name: channel.name,
      is_private: channel.isPrivate,
      is_member: channel.isMember,
    };
  }

  private mintTs(): string {
    this.nextTs += 1;
    return `${this.nextTs}.000100`;
  }
}

type FakeSlackMessage = {
  ts: string;
  text: string;
  blocks?: Record<string, unknown>[];
  threadTs?: string;
  user?: string;
  botId?: string;
  reactions?: string[];
  metadata?: {
    event_type: string;
    event_payload: Record<string, unknown>;
  };
};

type FakeSlackChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
};
