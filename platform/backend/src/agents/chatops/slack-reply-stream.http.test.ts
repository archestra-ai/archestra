import { WebClient } from "@slack/web-api";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { useMswServer } from "@/test/msw";
import { SlackReplyStream } from "./slack-reply-stream";

describe("Slack reply stream HTTP boundary", () => {
  const server = useMswServer();

  test("the Slack SDK sends bounded details on the original stream and never sends result bodies", async () => {
    const requests: { method: string; body: Record<string, string> }[] = [];
    server.use(
      http.post(
        "https://slack.com/api/:method",
        async ({ request, params }) => {
          const body = Object.fromEntries(
            new URLSearchParams(await request.text()),
          );
          requests.push({ method: String(params.method), body });
          return HttpResponse.json({ ok: true, ts: "100.2" });
        },
      ),
    );
    const stream = new SlackReplyStream({
      client: new WebClient("fixture-unused-token", {
        retryConfig: { retries: 0 },
      }),
      channelId: "C_ORIGINAL",
      threadTs: "100.1",
      recipient: { userId: "U_ORIGINAL", teamId: "T_ORIGINAL" },
      fitsOneMessage: () => true,
      buildTrailingBlocks: () => [],
      postReply: async () => {
        throw new Error("unexpected fallback");
      },
    });
    stream.push({
      type: "tool-input-available",
      toolCallId: "call-1",
      toolName: "example__create_task",
      input: {
        title: "Example task",
        headers: { "x-custom": "fixture-header-secret" },
      },
    });
    stream.push({
      type: "tool-output-error",
      toolCallId: "call-1",
      errorText: "403 missing scope; password=fixture-password",
    });
    stream.push({
      type: "tool-input-available",
      toolCallId: "call-2",
      toolName: "example__find_task",
      input: { query: "Example task" },
    });
    stream.push({
      type: "tool-output-available",
      toolCallId: "call-2",
      output: { privateResult: "withheld-tool-output" },
    });
    await stream.finish({
      text: "The assignment failed. The search succeeded.",
    });

    expect(requests.map(({ method }) => method)).toEqual([
      "chat.startStream",
      "chat.stopStream",
    ]);
    expect(requests[0]?.body).toMatchObject({
      channel: "C_ORIGINAL",
      thread_ts: "100.1",
      recipient_user_id: "U_ORIGINAL",
      recipient_team_id: "T_ORIGINAL",
      task_display_mode: "plan",
    });
    expect(requests[1]?.body).toMatchObject({
      channel: "C_ORIGINAL",
      ts: "100.2",
    });
    const chunks = JSON.parse(requests[0]?.body.chunks ?? "[]");
    expect(chunks[0].details).toContain("Example task");
    expect(chunks[1]).toMatchObject({
      id: "call-1",
      status: "error",
      output: expect.stringContaining("403 missing scope"),
    });
    expect(chunks[3]).toMatchObject({
      id: "call-2",
      status: "complete",
    });
    for (const chunk of chunks) {
      if (chunk.details) expect(chunk.details.length).toBeLessThanOrEqual(256);
      expect(chunk.title.length).toBeLessThanOrEqual(256);
      if (chunk.output) expect(chunk.output.length).toBeLessThanOrEqual(256);
    }
    // Live Slack appends the details of successive task_update chunks. Pin
    // the stored result, including its bound, across the status transition.
    for (const id of ["call-1", "call-2"]) {
      const details = chunks
        .filter((chunk: { id: string }) => chunk.id === id)
        .map((chunk: { details?: string }) => chunk.details ?? "")
        .join("");
      expect(details.match(/Arguments:/g)).toHaveLength(1);
      expect(details.length).toBeLessThanOrEqual(256);
    }
    expect(JSON.stringify(requests)).not.toMatch(
      /fixture-header-secret|fixture-password|withheld-tool-output/,
    );
  });
});
