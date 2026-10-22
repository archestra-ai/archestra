import { randomUUID } from "node:crypto";
import config from "@/config";
import { describe, expect, test } from "@/test";
import { FakeSlack } from "@/test/fake-slack";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import devFeedbackRoutes from "./dev-feedback.routes";

describe("POST /api/dev-feedback/comments", () => {
  const ctx = useRouteTestApp(devFeedbackRoutes);
  const server = useMswServer();

  test("is not served on deployments that do not turn it on", async () => {
    // Set explicitly: a developer's .env may turn it on.
    config.devFeedback.enabled = false;

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload: commentBody(),
    });

    expect(response.statusCode).toBe(404);
  });

  test("posts the comment with its anchor and screenshot, and the clip into its thread", async () => {
    const slack = await enableFeedbackChannel();
    server.use(...slack.handlers());

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload: commentBody({
        clip: { mimeType: "video/mp4", base64: "AAAA" },
      }),
    });

    expect(response.statusCode).toBe(200);
    const comment = response.json();
    const [posted] = slack.messages;
    const [screenshot, clip] = slack.uploads;
    expect(posted.metadata?.event_payload).toMatchObject({
      route: "/chat/[conversationId]",
      selector: '[data-testid="private-mode-banner"] > p:nth-of-type(1)',
      text: "The banner wraps <badly>",
      authorName: ctx.user.name,
    });
    // The screenshot shows the comment, so the message body is only the
    // author line, linking to this exact comment, and the picture. The link
    // keeps the page path but always points at this deployment.
    expect(posted.blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${ctx.user.name}* on <${new URL("/chat/8f3a", config.frontendBaseUrl)}#dev-feedback-comment=${posted.ts}|/chat/[conversationId]>`,
        },
      },
      {
        type: "image",
        slack_file: { id: screenshot.id },
        alt_text: "The banner wraps <badly>",
      },
    ]);
    expect(screenshot).toMatchObject({
      threadTs: "",
      filenames: ["screenshot.jpg"],
    });
    expect(clip).toMatchObject({
      threadTs: posted.ts,
      filenames: ["clip.mp4"],
    });
    expect(comment).toMatchObject({
      id: posted.ts,
      route: "/chat/[conversationId]",
      authorName: ctx.user.name,
      replyCount: 0,
      permalink: `https://acme.slack.com/archives/${slack.channel}/p${posted.ts.replace(".", "")}`,
    });
  });

  test("waits for Slack to finish processing the screenshot", async () => {
    const slack = await enableFeedbackChannel();
    slack.imageNotReadyPosts = 1;
    server.use(...slack.handlers());

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload: commentBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(slack.messages).toHaveLength(1);
    expect(slack.messages[0].blocks?.[1]).toMatchObject({ type: "image" });
  });

  test("puts the comment text in the message when there is no screenshot", async () => {
    const slack = await enableFeedbackChannel();
    server.use(...slack.handlers());

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload: commentBody({ screenshot: undefined }),
    });

    expect(response.statusCode).toBe(200);
    expect(slack.messages).toHaveLength(1);
    expect(slack.messages[0].blocks).toBeUndefined();
    expect(slack.messages[0].text).toContain(
      "> The banner wraps &lt;badly&gt;",
    );
    expect(slack.uploads).toEqual([]);
  });
});

async function enableFeedbackChannel() {
  const slack = new FakeSlack(`C${randomUUID().slice(0, 8)}`);
  await slack.configureAsDevFeedbackChannel();
  return slack;
}

function commentBody(overrides: Record<string, unknown> = {}) {
  return {
    route: "/chat/[conversationId]",
    url: "https://frontend.example.test/chat/8f3a",
    selector: '[data-testid="private-mode-banner"] > p:nth-of-type(1)',
    label: 'private-mode-banner › p "Use this mode for…"',
    elementX: 0.4,
    elementY: 0.5,
    viewportX: 0.3,
    viewportY: 0.2,
    viewport: "1440x900",
    text: "The banner wraps <badly>",
    screenshot: { mimeType: "image/jpeg", base64: "/9j/4AAQ" },
    ...overrides,
  };
}
