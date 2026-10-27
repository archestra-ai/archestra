import { randomUUID } from "node:crypto";
import { describe, expect, test } from "@/test";
import { FakeSlack } from "@/test/fake-slack";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import devFeedbackRoutes from "./dev-feedback.routes";

describe("GET /api/dev-feedback/comments", () => {
  const ctx = useRouteTestApp(devFeedbackRoutes);
  const server = useMswServer();

  test("returns the open comments pinned on the route, oldest first", async () => {
    const slack = new FakeSlack(`C${randomUUID().slice(0, 8)}`);
    await slack.configureAsDevFeedbackChannel();
    server.use(...slack.handlers());

    const first = slack.addMessage(feedbackMessage("/agents", "first"));
    slack.addMessage(feedbackMessage("/chat/[conversationId]", "other page"));
    slack.addMessage({
      ...feedbackMessage("/agents", "already fixed"),
      reactions: ["white_check_mark"],
    });
    slack.addMessage({ text: "unrelated chatter", user: "U1" });
    const second = slack.addMessage(feedbackMessage("/agents", "second"));
    slack.addMessage({ text: "on it", user: "U1", threadTs: second.ts });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/dev-feedback/comments?route=/agents",
    });

    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .map((comment: { id: string; text: string; replyCount: number }) => ({
          id: comment.id,
          text: comment.text,
          replyCount: comment.replyCount,
        })),
    ).toEqual([
      { id: first.ts, text: "first", replyCount: 0 },
      { id: second.ts, text: "second", replyCount: 1 },
    ]);
  });
});

function feedbackMessage(route: string, text: string) {
  return {
    text,
    botId: "B1",
    metadata: {
      event_type: "archestra_dev_feedback_comment",
      event_payload: {
        route,
        selector: "main > div:nth-of-type(1)",
        label: "main › div",
        elementX: 0.5,
        elementY: 0.5,
        viewportX: 0.5,
        viewportY: 0.5,
        text,
        authorName: "Ada",
      },
    },
  };
}
