import type { WebClient } from "@slack/web-api";
import type { UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SlackReplyStream, updatePausedTasks } from "./slack-reply-stream";

// The Slack Web API is the process boundary: a fake client records every call,
// and keeps the thread's stored messages for reads and edits.
function createStream(
  options: { recipient?: boolean; startError?: Error } = {},
) {
  const thread: SlackMessage[] = [];
  const chat = {
    startStream: options.startError
      ? vi.fn().mockRejectedValue(options.startError)
      : vi.fn().mockResolvedValue({ ok: true, ts: "STREAM.1" }),
    appendStream: vi.fn().mockResolvedValue({ ok: true }),
    stopStream: vi.fn().mockResolvedValue({ ok: true }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    update: vi.fn(
      async (args: { ts: string; text: string; blocks: unknown[] }) => {
        const message = thread.find((m) => m.ts === args.ts);
        if (!message) throw new Error("message_not_found");
        message.text = args.text;
        message.blocks = args.blocks as SlackMessage["blocks"];
        return { ok: true };
      },
    ),
  };
  const conversations = {
    replies: vi.fn(async (args: { oldest?: string; latest?: string }) => ({
      ok: true,
      messages: thread.filter(
        (m) =>
          (!args.oldest || m.ts >= args.oldest) &&
          (!args.latest || m.ts <= args.latest),
      ),
    })),
  };
  const client = { chat, conversations } as unknown as WebClient;
  const postReply = vi.fn().mockResolvedValue(undefined);
  const stream = new SlackReplyStream({
    client,
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
  return { stream, chat, postReply, thread, client };
}

interface SlackMessage {
  ts: string;
  text: string;
  blocks: {
    type: string;
    title?: string;
    tasks?: { task_id: string; title: string; status: string }[];
  }[];
}

/** What Slack stores for a stream stopped with a task still pending. */
function stoppedWithPendingTask(ts: string, taskId: string): SlackMessage {
  return {
    ts,
    text: "Checking the policy.",
    blocks: [
      { type: "rich_text" },
      {
        type: "plan",
        title: "Something went wrong",
        tasks: [{ task_id: taskId, title: "remedy", status: "error" }],
      },
    ],
  };
}

function planOf(message: SlackMessage | undefined) {
  const plan = message?.blocks.find((block) => block.type === "plan");
  return {
    title: plan?.title,
    statuses: plan?.tasks?.map((task) => task.status),
  };
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
  test("updates one pending card with complete arguments, then settles it once", async () => {
    const { stream, chat } = createStream();
    stream.push({
      type: "tool-input-start",
      toolCallId: "pending-1",
      toolName: "tracker__find_task",
    });
    stream.push({
      type: "tool-input-delta",
      toolCallId: "pending-1",
      inputTextDelta: '{"token":"fixture-partial-secret"',
    });
    await flush();
    expect(chat.startStream.mock.calls[0][0].chunks).toEqual([
      {
        type: "task_update",
        id: "pending-1",
        title: "tracker__find_task",
        status: "pending",
      },
    ]);
    stream.push({
      type: "tool-input-available",
      toolCallId: "pending-1",
      toolName: "tracker__find_task",
      input: { query: "Example task" },
    });
    await flush();
    const running = chat.appendStream.mock.calls[0][0].chunks[0];
    expect(running).toMatchObject({
      id: "pending-1",
      status: "in_progress",
      details: 'Arguments: {"query":"Example task"}',
    });
    stream.push({
      type: "tool-output-available",
      toolCallId: "pending-1",
      output: "private preliminary output",
      preliminary: true,
    });
    await flush();
    expect(chat.appendStream).toHaveBeenCalledTimes(1);
    stream.push({
      type: "tool-output-available",
      toolCallId: "pending-1",
      output: "private final output",
    });
    stream.push({
      type: "tool-output-error",
      toolCallId: "pending-1",
      errorText: "late duplicate",
    });
    await flush();
    expect(chat.appendStream.mock.calls[1][0].chunks).toEqual([
      {
        type: "task_update",
        id: "pending-1",
        title: "tracker__find_task",
        status: "complete",
      },
    ]);
    expect(JSON.stringify(chat.startStream.mock.calls)).not.toContain(
      "fixture-partial-secret",
    );
    await stream.finish({ text: "Done" });
  });

  test("marks MCP failure results as failed without exposing their withheld body", async () => {
    const { stream, chat } = createStream();
    stream.push({
      type: "tool-input-available",
      toolCallId: "mcp-error",
      toolName: "example__tool",
      input: {},
    });
    stream.push({
      type: "tool-output-available",
      toolCallId: "mcp-error",
      output: {
        isError: true,
        content: [{ type: "text", text: "private failure body" }],
        structuredContent: { password: "fixture-private-password" },
      },
    });
    await flush();
    expect(chat.startStream.mock.calls[0][0].chunks[1]).toMatchObject({
      status: "error",
      output: "Tool reported an error",
    });
    expect(JSON.stringify(chat.startStream.mock.calls)).not.toMatch(
      /private failure body|fixture-private-password/,
    );
    await stream.finish({ text: "Failed" });
  });

  test("input validation errors settle even without a preceding input event", async () => {
    const { stream, chat } = createStream();
    stream.push({
      type: "tool-input-error",
      toolCallId: "invalid",
      toolName: "example__tool",
      input: '{"password":"fixture-malformed-secret"',
      errorText: "Invalid input: expected task_id",
    });
    await flush();
    expect(chat.startStream.mock.calls[0][0].chunks).toEqual([
      {
        type: "task_update",
        id: "invalid",
        title: "example__tool",
        status: "error",
        output: "Invalid input: expected task_id",
      },
    ]);
    await stream.finish({ text: "Failed" });
  });

  test("keeps approval denial distinct from a successful retry", async () => {
    const { stream, chat } = createStream();
    stream.push({
      type: "tool-input-available",
      toolCallId: "denied",
      toolName: "example__tool",
      input: { task_id: "EXAMPLE-42" },
    });
    stream.push({
      type: "tool-approval-request",
      toolCallId: "denied",
      approvalId: "review-1",
    });
    await flush();
    expect(chat.startStream.mock.calls[0][0].chunks[1]).toMatchObject({
      id: "denied",
      status: "pending",
    });
    stream.push({ type: "tool-output-denied", toolCallId: "denied" });
    stream.push({
      type: "tool-input-available",
      toolCallId: "retry",
      toolName: "example__tool",
      input: { task_id: "EXAMPLE-42" },
    });
    stream.push({
      type: "tool-output-available",
      toolCallId: "retry",
      output: {},
    });
    await flush();
    expect(chat.appendStream.mock.calls[0][0].chunks).toMatchObject([
      { id: "denied", status: "error", output: "Denied" },
      { id: "retry", status: "in_progress" },
      { id: "retry", status: "complete" },
    ]);
    await stream.finish({ text: "Done" });
    expect(chat.update).not.toHaveBeenCalled();
  });

  test("cancellation retains sanitized arguments and ignores later updates", async () => {
    const { stream, chat } = createStream();
    stream.push({
      type: "tool-input-available",
      toolCallId: "cancelled",
      toolName: "example__tool",
      input: { task_id: "EXAMPLE-42", token: "fixture-secret" },
    });
    await flush();
    await stream.abandon({ keepContent: true });
    expect(chat.stopStream.mock.calls[0][0].chunks[0]).toMatchObject({
      id: "cancelled",
      status: "error",
      output: "Stopped",
    });
    expect(JSON.stringify(chat.stopStream.mock.calls)).not.toContain(
      "fixture-secret",
    );
    expect(chat.stopStream.mock.calls[0][0].chunks[0]).not.toHaveProperty(
      "details",
    );
    expect(chat.startStream.mock.calls[0][0].chunks[0].details).toContain(
      "EXAMPLE-42",
    );
    stream.push({
      type: "tool-output-available",
      toolCallId: "cancelled",
      output: {},
    });
    await flush();
    expect(chat.appendStream).not.toHaveBeenCalled();
  });

  test("shows sanitized arguments through completion without publishing result bodies", async () => {
    const { stream, chat } = createStream({ recipient: true });
    stream.push({
      type: "tool-input-available",
      toolCallId: "details-1",
      toolName: "archestra__run_tool",
      input: {
        tool_name: "tracker__create_task",
        tool_args: JSON.stringify({
          title: "Example task",
          password: "fixture-password",
        }),
      },
    });
    await flush();
    const started = chat.startStream.mock.calls[0][0].chunks[0];
    expect(started.title).toBe("tracker__create_task");
    expect(started.details).toContain("Example task");
    expect(started.details).toContain("[redacted]");
    expect(started.details).not.toContain("fixture-password");
    stream.push({
      type: "tool-output-available",
      toolCallId: "details-1",
      output: { privateResult: "result for model only" },
    });
    await flush();
    expect(chat.appendStream.mock.calls[0][0].chunks[0]).toMatchObject({
      status: "complete",
    });
    expect(chat.appendStream.mock.calls[0][0].chunks[0]).not.toHaveProperty(
      "details",
    );
    expect(JSON.stringify(chat.appendStream.mock.calls)).not.toContain(
      "result for model only",
    );
    await stream.finish({ text: "Done" });
  });

  test("redacts error credentials before they reach Slack", async () => {
    const { stream, chat } = createStream();
    stream.push({
      type: "tool-input-available",
      toolCallId: "error-1",
      toolName: "tracker__create_task",
      input: {},
    });
    stream.push({
      type: "tool-output-error",
      toolCallId: "error-1",
      errorText:
        "Request failed (403): Authorization: Bearer fixture-access-token password=fixture-password",
    });
    await flush();
    const failed = chat.startStream.mock.calls[0][0].chunks[1];
    expect(failed.status).toBe("error");
    expect(failed.output).toContain("403");
    expect(failed.output).not.toContain("fixture-access-token");
    expect(failed.output).not.toContain("fixture-password");
    await stream.finish({ text: "Failed" });
  });

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
      task_display_mode: "plan",
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

  test("an approval pause shows the paused tool card as waiting, and the decision settles it", async () => {
    const { stream, chat, thread, client } = createStream();
    thread.push({ ts: "100.1", text: "user asks", blocks: [] });
    stream.push(text("Checking the policy."));
    stream.push({
      type: "tool-input-available",
      toolCallId: "call-1",
      toolName: "archestra__execute_remedy_plan",
      input: {},
    });
    stream.push({
      type: "tool-approval-request",
      approvalId: "approval-1",
      toolCallId: "call-1",
    });
    await flush();
    chat.stopStream.mockImplementationOnce(async () => {
      thread.push(stoppedWithPendingTask("STREAM.1", "call-1"));
      return { ok: true };
    });

    await stream.finish({ text: "Checking the policy." });
    expect(planOf(thread[1])).toEqual({
      title: "Waiting for approval",
      statuses: ["pending"],
    });

    // The resumed run answers in a new message; the decision finds the paused
    // reply in the thread by its tool call.
    thread.push({ ts: "STREAM.2", text: "approval form", blocks: [] });
    await updatePausedTasks({
      client,
      channelId: "C1",
      threadTs: "100.1",
      taskIds: ["call-1"],
      outcome: "approved",
    });
    expect(planOf(thread[1])).toEqual({
      title: "Approved",
      statuses: ["complete"],
    });
    expect(thread[1].text).toBe("Checking the policy.");
  });

  test("a declined approval marks the paused tool card failed", async () => {
    const { thread, client } = createStream();
    thread.push(stoppedWithPendingTask("STREAM.1", "call-1"));

    await updatePausedTasks({
      client,
      channelId: "C1",
      threadTs: "100.1",
      taskIds: ["call-1"],
      outcome: "declined",
    });
    expect(planOf(thread[0])).toEqual({
      title: "Declined",
      statuses: ["error"],
    });
  });

  test("a tool card left open without an approval request is not rewritten", async () => {
    const { stream, chat } = createStream();
    stream.push(text("Working on it."));
    stream.push({
      type: "tool-input-available",
      toolCallId: "call-1",
      toolName: "slow_tool",
      input: {},
    });
    await flush();

    await stream.finish({ text: "Working on it." });
    expect(chat.stopStream).toHaveBeenCalledTimes(1);
    expect(chat.stopStream.mock.calls[0][0].chunks[0]).toMatchObject({
      id: "call-1",
      status: "error",
      output: "Tool did not finish",
    });
    expect(chat.update).not.toHaveBeenCalled();
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
