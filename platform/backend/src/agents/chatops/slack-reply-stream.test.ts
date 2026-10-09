import type { WebClient } from "@slack/web-api";
import type { UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SlackReplyStream } from "./slack-reply-stream";

// The Slack Web API is the process boundary: a fake client records every call.
function createStream(
  options: { recipient?: boolean; startError?: Error } = {},
) {
  const chat = {
    startStream: options.startError
      ? vi.fn().mockRejectedValue(options.startError)
      : vi.fn().mockResolvedValue({ ok: true, ts: "STREAM.1" }),
    appendStream: vi.fn().mockResolvedValue({ ok: true }),
    stopStream: vi.fn().mockResolvedValue({ ok: true }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
  };
  const postReply = vi.fn().mockResolvedValue(undefined);
  const stream = new SlackReplyStream({
    client: { chat } as unknown as WebClient,
    channelId: "C1",
    threadTs: "100.1",
    ...(options.recipient && {
      recipient: { userId: "U1", teamId: "T1" },
    }),
    fitsOneMessage: (text) => text.length <= 200,
    buildTrailingBlocks: ({ footer }) =>
      footer
        ? [
            {
              type: "context",
              elements: [{ type: "plain_text", text: footer }],
            },
          ]
        : [],
    postReply,
  });
  return { stream, chat, postReply };
}

const text = (delta: string): UIMessageChunk => ({
  type: "text-delta",
  id: "t",
  delta,
});

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SlackReplyStream", () => {
  test("streams text and tool cards in order, then appends only the tail", async () => {
    const { stream, chat, postReply } = createStream({ recipient: true });

    stream.push(text("Looking "));
    stream.push(text("it up."));
    stream.push({
      type: "tool-input-available",
      toolCallId: "call-1",
      toolName: "github__search_issues",
      input: {},
    });
    await flush();
    expect(stream.isLive).toBe(true);
    expect(chat.startStream).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "100.1",
      task_display_mode: "timeline",
      recipient_user_id: "U1",
      recipient_team_id: "T1",
      chunks: [
        { type: "markdown_text", text: "Looking it up." },
        {
          type: "task_update",
          id: "call-1",
          title: "github__search_issues",
          status: "in_progress",
        },
      ],
    });

    stream.push({
      type: "tool-output-available",
      toolCallId: "call-1",
      output: {},
    });
    await flush();
    expect(chat.appendStream).toHaveBeenCalledWith({
      channel: "C1",
      ts: "STREAM.1",
      chunks: [
        {
          type: "task_update",
          id: "call-1",
          title: "github__search_issues",
          status: "complete",
        },
      ],
    });

    await stream.finish({
      text: "Looking it up. Found 3 issues.",
      footer: "🤖 Agent",
    });
    expect(chat.stopStream).toHaveBeenCalledWith({
      channel: "C1",
      ts: "STREAM.1",
      chunks: [{ type: "markdown_text", text: " Found 3 issues." }],
      blocks: [
        {
          type: "context",
          elements: [{ type: "plain_text", text: "🤖 Agent" }],
        },
      ],
    });
    expect(postReply).not.toHaveBeenCalled();
    expect(stream.isLive).toBe(false);
  });

  test("names the tool a run_tool call dispatches to", async () => {
    const { stream, chat } = createStream();
    stream.push({
      type: "tool-input-available",
      toolCallId: "call-1",
      toolName: "archestra__run_tool",
      input: { tool_name: "jira__create_issue", tool_args: {} },
    });
    await flush();
    expect(chat.startStream.mock.calls[0][0].chunks[0].title).toBe(
      "jira__create_issue",
    );
  });

  test("never shows the no-reply sentinel or inline thinking", async () => {
    const { stream, chat } = createStream();
    stream.push(text("<thinking>should I answer?</thinking>"));
    stream.push(text("[NO_"));
    await flush();
    stream.push(text("REPLY]"));
    await flush();
    expect(chat.startStream).not.toHaveBeenCalled();
    expect(stream.isLive).toBe(false);
  });

  test("an unclosed thinking block is held back until it closes", async () => {
    const { stream, chat } = createStream();
    stream.push(text("Sure. <think"));
    await flush();
    stream.push(text("ing>hmm"));
    await flush();
    stream.push(text("</thinking> Done."));
    await flush();
    const shown = [
      ...chat.startStream.mock.calls.map((call) => call[0].chunks),
      ...chat.appendStream.mock.calls.map((call) => call[0].chunks),
    ]
      .flat()
      .map((chunk: { text: string }) => chunk.text)
      .join("");
    expect(shown).toBe("Sure.  Done.");
  });

  test("replaces the streamed message when the final reply is not its continuation", async () => {
    const { stream, chat, postReply } = createStream();
    stream.push(text("Run abc started, here is the full log..."));
    await flush();

    const final = { text: "Run abc started — I'll post the result here." };
    await stream.finish(final);

    expect(chat.stopStream).toHaveBeenCalledWith({
      channel: "C1",
      ts: "STREAM.1",
    });
    expect(postReply).toHaveBeenCalledWith(final, "STREAM.1");
  });

  test("replaces the streamed message when the reply outgrows one message", async () => {
    const { stream, postReply } = createStream();
    stream.push(text("Short start. "));
    await flush();
    stream.push(text("x".repeat(500)));
    await flush();

    const final = { text: `Short start. ${"x".repeat(500)}` };
    await stream.finish(final);
    expect(postReply).toHaveBeenCalledWith(final, "STREAM.1");
  });

  test("a stream Slack refuses to start leaves the reply to the ordinary path", async () => {
    const { stream, postReply } = createStream({
      startError: new Error("not_allowed"),
    });
    stream.push(text("Hello"));
    await flush();
    expect(stream.isLive).toBe(false);

    await stream.finish({ text: "Hello there" });
    expect(postReply).toHaveBeenCalledWith({ text: "Hello there" });
  });

  test("abandoning without keeping content deletes the streamed message", async () => {
    const { stream, chat } = createStream();
    stream.push(text("Half an answer"));
    await flush();

    await stream.abandon({ keepContent: false });
    expect(chat.delete).toHaveBeenCalledWith({ channel: "C1", ts: "STREAM.1" });
    expect(stream.isLive).toBe(false);
  });

  test("a stopped stream keeps its content and marks open tool cards stopped", async () => {
    const { stream, chat } = createStream();
    stream.push({
      type: "tool-input-available",
      toolCallId: "call-1",
      toolName: "slow_tool",
      input: {},
    });
    await flush();

    await stream.abandon({ keepContent: true });
    expect(chat.delete).not.toHaveBeenCalled();
    expect(chat.stopStream).toHaveBeenCalledWith({
      channel: "C1",
      ts: "STREAM.1",
      chunks: [
        {
          type: "task_update",
          id: "call-1",
          title: "slow_tool",
          status: "error",
          output: "Stopped",
        },
      ],
    });
  });
});
