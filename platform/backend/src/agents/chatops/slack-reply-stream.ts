import type { AnyChunk, WebClient } from "@slack/web-api";
import type { UIMessageChunk } from "ai";
import { resolveRunToolTarget } from "@/archestra-mcp-server/run-tool-target";
import logger from "@/logging";
import type { ChatOpsReplyStream, ChatReplyOptions } from "@/types";
import { CHATOPS_NO_REPLY_SENTINEL } from "./constants";
import { errorMessage, stripDuplicateAgentFooter } from "./utils";

type FinalReply = Pick<ChatReplyOptions, "text" | "footer" | "hint">;

/**
 * Streams an agent reply into a Slack thread with chat.startStream /
 * appendStream / stopStream: text renders as the model writes it, and every
 * tool call shows as a task card that flips to done or failed.
 *
 * The stream is a preview. The final reply the manager hands to `finish` is
 * authoritative: when it is the streamed text plus a tail, only the tail is
 * appended; when it differs (an inline thinking block, a rewritten launch
 * message, an echoed footer, or a reply too long for one message), the
 * streamed message is replaced with the ordinary rendering of the final reply.
 *
 * Every Slack call is best-effort. A stream that cannot start leaves `isLive`
 * false, so the manager posts the reply the ordinary way; one that breaks
 * midway is still replaced on `finish`.
 */
export class SlackReplyStream implements ChatOpsReplyStream {
  private ts: string | null = null;
  private broken = false;
  private closed = false;
  /** Raw model text, thinking blocks and all. */
  private rawText = "";
  /** The prefix of the visible text already handed to Slack. */
  private shownText = "";
  /** Set once the shown text stopped tracking the visible text. */
  private textDiverged = false;
  private queue: AnyChunk[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> = Promise.resolve();
  /** Tool calls shown as task cards, by toolCallId, until they settle. */
  private readonly openTasks = new Map<string, string>();

  constructor(private readonly deps: SlackReplyStreamDeps) {}

  get isLive(): boolean {
    return this.ts !== null && !this.closed;
  }

  push(chunk: UIMessageChunk): void {
    if (this.closed || (this.broken && !this.ts)) return;
    switch (chunk.type) {
      case "text-delta":
        this.rawText += chunk.delta;
        this.scheduleFlush();
        return;
      case "tool-input-available": {
        // `run_tool` is a dispatch wrapper — name the tool it actually runs.
        const { toolName } = resolveRunToolTarget({
          toolName: chunk.toolName,
          args: chunk.input,
        });
        const title = truncate(toolName, TASK_TEXT_LIMIT);
        this.openTasks.set(chunk.toolCallId, title);
        this.enqueueTask({
          id: chunk.toolCallId,
          title,
          status: "in_progress",
        });
        return;
      }
      case "tool-output-available":
        if (chunk.preliminary) return;
        this.settleTask(chunk.toolCallId, { status: "complete" });
        return;
      case "tool-output-error":
        this.settleTask(chunk.toolCallId, {
          status: "error",
          output: truncate(chunk.errorText, TASK_TEXT_LIMIT),
        });
        return;
      case "tool-output-denied":
        this.settleTask(chunk.toolCallId, {
          status: "error",
          output: "Denied",
        });
        return;
      default:
        return;
    }
  }

  async finish(options: FinalReply): Promise<void> {
    if (this.closed) return;
    await this.drain();
    this.closed = true;

    const finalText = options.footer
      ? stripDuplicateAgentFooter(options.text, options.footer)
      : options.text;

    if (!this.ts) {
      await this.deps.postReply(options);
      return;
    }
    const ts = this.ts;

    // Tasks still open when the run settled never ran (an approval pause).
    const leftoverTasks = this.closeOpenTasks({ status: "pending" });
    const tail = this.textDiverged
      ? null
      : appendableTail(this.shownText, finalText);
    if (!this.broken && tail !== null && this.deps.fitsOneMessage(finalText)) {
      try {
        await this.deps.client.chat.stopStream({
          channel: this.deps.channelId,
          ts,
          ...(tail || leftoverTasks.length > 0
            ? {
                chunks: [
                  ...(tail
                    ? [{ type: "markdown_text" as const, text: tail }]
                    : []),
                  ...leftoverTasks,
                ],
              }
            : {}),
          blocks: this.deps.buildTrailingBlocks(options),
        });
        return;
      } catch (error) {
        logger.debug(
          { error: errorMessage(error), channelId: this.deps.channelId },
          "[SlackReplyStream] chat.stopStream failed; replacing the streamed message",
        );
      }
    }

    await this.stopQuietly(ts);
    try {
      await this.deps.postReply(options, ts);
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), channelId: this.deps.channelId },
        "[SlackReplyStream] Could not replace the streamed message; posting the reply anew",
      );
      await this.deps.postReply(options);
    }
  }

  async abandon(options: { keepContent: boolean }): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearFlushTimer();
    this.queue = [];
    // A startStream in flight may still land and hand us a ts to clean up.
    await this.sending;
    if (!this.ts) return;
    const ts = this.ts;

    if (options.keepContent) {
      await this.stopQuietly(
        ts,
        this.closeOpenTasks({ status: "error", output: "Stopped" }),
      );
      return;
    }
    await this.stopQuietly(ts);
    try {
      await this.deps.client.chat.delete({ channel: this.deps.channelId, ts });
    } catch (error) {
      logger.debug(
        { error: errorMessage(error), channelId: this.deps.channelId },
        "[SlackReplyStream] Failed to delete an abandoned streamed message",
      );
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private enqueueTask(task: TaskUpdate): void {
    // Text written before the tool call renders above its card.
    this.captureText();
    this.queue.push({ type: "task_update", ...task });
    this.scheduleFlush();
  }

  private settleTask(
    toolCallId: string,
    result: Pick<TaskUpdate, "status" | "output">,
  ): void {
    const title = this.openTasks.get(toolCallId);
    if (title === undefined) return;
    this.openTasks.delete(toolCallId);
    this.enqueueTask({ id: toolCallId, title, ...result });
  }

  private closeOpenTasks(
    result: Pick<TaskUpdate, "status" | "output">,
  ): AnyChunk[] {
    const updates = [...this.openTasks].map(([id, title]) => ({
      type: "task_update" as const,
      id,
      title,
      ...result,
    }));
    this.openTasks.clear();
    return updates;
  }

  /**
   * Move newly visible text into the send queue. Text is withheld while it
   * could still turn out to be the agent's no-reply sentinel or an inline
   * thinking block, and abandoned (left to `finish` to replace) once it grows
   * past what one Slack message can hold or stops extending what was shown.
   */
  private captureText(): void {
    if (this.textDiverged) return;
    const visible = visibleStreamText(this.rawText);
    if (mightBeSilence(visible)) return;
    if (!visible.startsWith(this.shownText)) {
      this.textDiverged = true;
      return;
    }
    const delta = visible.slice(this.shownText.length);
    if (!delta) return;
    if (!this.deps.fitsOneMessage(visible)) {
      this.textDiverged = true;
      return;
    }
    this.shownText = visible;
    this.queue.push({ type: "markdown_text", text: delta });
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flush(): void {
    this.captureText();
    const chunks = this.queue;
    this.queue = [];
    if (chunks.length === 0) return;
    this.sending = this.sending.then(() => this.send(chunks));
  }

  /** Send everything captured so far and wait for it to land. */
  private async drain(): Promise<void> {
    this.clearFlushTimer();
    this.flush();
    await this.sending;
  }

  private async send(chunks: AnyChunk[]): Promise<void> {
    if (this.broken) return;
    const { client, channelId, threadTs, recipient } = this.deps;
    try {
      if (!this.ts) {
        const result = await client.chat.startStream({
          channel: channelId,
          thread_ts: threadTs,
          chunks: coalesceText(chunks),
          task_display_mode: "timeline",
          ...(recipient && {
            recipient_user_id: recipient.userId,
            recipient_team_id: recipient.teamId,
          }),
        });
        if (!result.ts) throw new Error("chat.startStream returned no ts");
        this.ts = result.ts;
        return;
      }
      await client.chat.appendStream({
        channel: channelId,
        ts: this.ts,
        chunks: coalesceText(chunks),
      });
    } catch (error) {
      // stopped_by_user lands here too: the run is being aborted already.
      this.broken = true;
      logger.debug(
        { error: errorMessage(error), channelId, started: Boolean(this.ts) },
        "[SlackReplyStream] Streaming call failed; falling back to a posted reply",
      );
    }
  }

  private async stopQuietly(
    ts: string,
    chunks: AnyChunk[] = [],
  ): Promise<void> {
    try {
      await this.deps.client.chat.stopStream({
        channel: this.deps.channelId,
        ts,
        ...(chunks.length > 0 && { chunks }),
      });
    } catch {
      // Already stopped (by the user, or a broken stream) — nothing to close.
    }
  }
}

// =============================================================================
// Internal Helpers
// =============================================================================

interface SlackReplyStreamDeps {
  client: WebClient;
  channelId: string;
  threadTs: string;
  /** Required by Slack when streaming outside a DM. */
  recipient?: { userId: string; teamId: string };
  /** Whether this text renders as a single Slack message. */
  fitsOneMessage: (text: string) => boolean;
  /** Context blocks (hint, footer) that close out a finished reply. */
  buildTrailingBlocks: (options: FinalReply) => SlackBlock[];
  /**
   * Post the reply the ordinary way; with `replaceTs`, its first message
   * replaces that one instead of posting a new one.
   */
  postReply: (options: FinalReply, replaceTs?: string) => Promise<void>;
}

type SlackBlock = NonNullable<
  Parameters<WebClient["chat"]["stopStream"]>[0]["blocks"]
>[number];

interface TaskUpdate {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "complete" | "error";
  output?: string;
}

/** appendStream is Tier 4 (100+/min); one call per interval stays well under. */
const FLUSH_INTERVAL_MS = 750;

/** Slack caps task_update titles and outputs at 256 characters. */
const TASK_TEXT_LIMIT = 256;

const THINKING_BLOCK = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
const THINKING_OPEN = /<think(?:ing)?>/i;

/**
 * The part of the raw model text that is safe to show while it is still being
 * written: closed thinking blocks removed (as stripThinkingBlocks does), and
 * everything from an unclosed thinking tag — or a trailing `<` that could open
 * one — held back until it resolves.
 */
function visibleStreamText(raw: string): string {
  let text = raw.replace(THINKING_BLOCK, "");
  const open = text.search(THINKING_OPEN);
  if (open >= 0) text = text.slice(0, open);
  const lastAngle = text.lastIndexOf("<");
  if (lastAngle >= 0 && "<thinking>".startsWith(text.slice(lastAngle))) {
    text = text.slice(0, lastAngle);
  }
  return text.trimStart();
}

/** Whether the text so far could still be the agent declining to reply. */
function mightBeSilence(visible: string): boolean {
  const text = visible.trim();
  return (
    !text ||
    CHATOPS_NO_REPLY_SENTINEL.startsWith(text) ||
    text.startsWith(CHATOPS_NO_REPLY_SENTINEL)
  );
}

/**
 * What to append so the streamed text becomes the final text, or null when the
 * final text does not simply extend it.
 */
function appendableTail(shown: string, final: string): string | null {
  if (final.startsWith(shown)) return final.slice(shown.length);
  if (shown.trimEnd() === final) return "";
  return null;
}

/** Merge adjacent markdown_text chunks so a flush carries one per run. */
function coalesceText(chunks: AnyChunk[]): AnyChunk[] {
  const merged: AnyChunk[] = [];
  for (const chunk of chunks) {
    const last = merged.at(-1);
    if (chunk.type === "markdown_text" && last?.type === "markdown_text") {
      merged[merged.length - 1] = {
        type: "markdown_text",
        text: last.text + chunk.text,
      };
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
