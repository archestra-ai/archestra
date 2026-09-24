import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { useMswServer } from "@/test/msw";
import type { IncomingChatMessage } from "@/types";
import SlackProvider from "./slack-provider";
import { parseSlackRichReply } from "./slack-rich-reply";

const header = {
  type: "header",
  text: { type: "plain_text", text: "Release ready" },
};
const link = {
  type: "button",
  text: { type: "plain_text", text: "View report" },
  url: "https://example.com/report",
};

function envelope(blocks: unknown[], text = "Release ready. View the report.") {
  return `\`\`\`slack-blocks\n${JSON.stringify({ text, blocks })}\n\`\`\``;
}

describe("rich Slack reply validation", () => {
  test("accepts display blocks and assigns isolated IDs to URL buttons", () => {
    const reply = parseSlackRichReply(
      envelope([
        header,
        { type: "divider" },
        {
          type: "section",
          fields: [{ type: "mrkdwn", text: "*Status:* Ready" }],
        },
        {
          type: "image",
          image_url: "https://example.com/chart.png",
          alt_text: "Release results",
        },
        {
          type: "context",
          elements: [{ type: "plain_text", text: "All checks passed" }],
        },
        { type: "actions", elements: [link, link] },
      ]),
    );
    expect(reply?.blocks).toHaveLength(6);
    expect(reply?.blocks[5]).toEqual({
      type: "actions",
      elements: [
        { ...link, action_id: "agent_rich_link_5_0" },
        { ...link, action_id: "agent_rich_link_5_1" },
      ],
    });
  });

  test.each([
    [
      "approval action",
      { ...link, action_id: "approval_decision_test_approve" },
    ],
    ["agent selection", { type: "static_select", action_id: "select_agent" }],
    ["callback value", { ...link, value: "approve" }],
    ["callback button", { type: "button", text: link.text }],
    ["script URL", { ...link, url: "javascript:alert(1)" }],
    ["HTTP URL", { ...link, url: "http://example.com" }],
    ["credential URL", { ...link, url: "https://user:pass@example.com" }],
    [
      "oversized label",
      { ...link, text: { type: "plain_text", text: "x".repeat(76) } },
    ],
  ])("rejects %s instead of forwarding it to Slack", (_name, button) => {
    expect(
      parseSlackRichReply(envelope([{ type: "actions", elements: [button] }])),
    ).toBeNull();
  });

  test.each([
    [
      {
        type: "input",
        label: header.text,
        element: { type: "plain_text_input" },
      },
    ],
    [{ ...header, block_id: "approval" }],
    [{ type: "section" }],
    [{ type: "section", fields: [] }],
    [{ type: "context", elements: [] }],
    [{ type: "image", image_url: "https://example.com/image.png" }],
    [{ type: "markdown", text: "Unbounded expansion" }],
    [{ type: "section", text: { type: "mrkdwn", text: "x".repeat(3001) } }],
    [
      {
        type: "section",
        fields: Array.from({ length: 11 }, () => header.text),
      },
    ],
    [
      {
        type: "context",
        elements: Array.from({ length: 11 }, () => header.text),
      },
    ],
    [{ type: "actions", elements: Array.from({ length: 26 }, () => link) }],
  ])("rejects unsupported or invalid block %#", (block) => {
    expect(parseSlackRichReply(envelope([block]))).toBeNull();
  });

  test("requires bounded nonempty fallback text and reserves footer slots", () => {
    expect(parseSlackRichReply(envelope([header], "  "))).toBeNull();
    expect(
      parseSlackRichReply(envelope([header], "x".repeat(3001))),
    ).toBeNull();
    expect(parseSlackRichReply(envelope([]))).toBeNull();
    expect(
      parseSlackRichReply(envelope(Array.from({ length: 48 }, () => header))),
    ).not.toBeNull();
    expect(
      parseSlackRichReply(envelope(Array.from({ length: 49 }, () => header))),
    ).toBeNull();
  });

  test("bounds the UTF-8 payload before decoding JSON", () => {
    const blocks = Array.from({ length: 20 }, () => ({
      type: "section",
      text: { type: "plain_text", text: "界".repeat(600) },
    }));
    const text = envelope(blocks);
    expect(text.length).toBeLessThan(32 * 1024);
    expect(Buffer.byteLength(text)).toBeGreaterThan(32 * 1024);
    expect(parseSlackRichReply(text)).toBeNull();
  });

  test.each([
    "Ordinary Markdown",
    '```json\n{"text":"example","blocks":[]}\n```',
    "```slack-blocks\nnot JSON\n```",
    `Here is an example:\n${envelope([header])}`,
    `${envelope([header])}\n${envelope([header])}`,
    '```slack-blocks\n{"text":"ok","blocks":[],"channel":"C_OTHER"}\n```',
  ])("leaves ordinary text, examples, and malformed envelopes unchanged: %#", (text) => {
    expect(parseSlackRichReply(text)).toBeNull();
  });
});

describe("rich replies through the Slack HTTP client", () => {
  const server = useMswServer(
    http.post("https://slack.com/api/auth.test", () =>
      HttpResponse.json({ ok: true }),
    ),
  );
  const originalMessage: IncomingChatMessage = {
    messageId: "1234567890.000001",
    channelId: "C_TEST",
    workspaceId: "T_TEST",
    threadId: "1234567890.000000",
    senderId: "U_TEST",
    senderName: "Test User",
    text: "Show the release report",
    rawText: "Show the release report",
    timestamp: new Date(),
    isThreadReply: true,
  };

  async function send(text: string) {
    const posts: URLSearchParams[] = [];
    server.use(
      http.post(
        "https://slack.com/api/chat.postMessage",
        async ({ request }) => {
          posts.push(new URLSearchParams(await request.text()));
          return HttpResponse.json({ ok: true, ts: "1234567890.000002" });
        },
      ),
    );
    const provider = new SlackProvider({
      enabled: true,
      botToken: "synthetic-token",
      signingSecret: "synthetic-secret",
      appId: "A_TEST",
      connectionMode: "webhook",
    });
    await provider.initialize();
    try {
      const ts = await provider.sendReply({
        originalMessage,
        text,
        footer: "Test Agent",
        hint: "Thread hint",
      });
      expect(ts).toBe("1234567890.000002");
      expect(posts).toHaveLength(1);
      expect(posts[0].get("channel")).toBe(originalMessage.channelId);
      expect(posts[0].get("thread_ts")).toBe(originalMessage.threadId);
      return posts[0];
    } finally {
      await provider.cleanup();
    }
  }

  test("posts visible blocks with accessible fallback and platform attribution", async () => {
    const post = await send(
      envelope([header, { type: "actions", elements: [link] }]),
    );
    expect(post.get("text")).toBe(
      "Release ready. View the report.\n\nTest Agent",
    );
    expect(JSON.parse(post.get("blocks") ?? "[]")).toEqual([
      header,
      {
        type: "actions",
        elements: [{ ...link, action_id: "agent_rich_link_1_0" }],
      },
      {
        type: "context",
        elements: [{ type: "plain_text", text: "Thread hint", emoji: true }],
      },
      {
        type: "context",
        elements: [{ type: "plain_text", text: "Test Agent", emoji: true }],
      },
    ]);
  });

  test("posts unsafe envelopes as text, with no executable controls", async () => {
    const text = envelope([
      { type: "actions", elements: [{ ...link, action_id: "select_agent" }] },
    ]);
    const post = await send(text);
    expect(JSON.parse(post.get("blocks") ?? "[]")[0]).toEqual({
      type: "markdown",
      text,
    });
  });

  test("keeps ordinary Markdown replies working", async () => {
    const post = await send("**Ready** to review.");
    expect(JSON.parse(post.get("blocks") ?? "[]")[0]).toEqual({
      type: "markdown",
      text: "**Ready** to review.",
    });
  });

  test("fits a maximum-size reply plus hint and footer into one message", async () => {
    const post = await send(envelope(Array.from({ length: 48 }, () => header)));
    expect(JSON.parse(post.get("blocks") ?? "[]")).toHaveLength(50);
  });
});
