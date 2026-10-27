import { randomUUID } from "node:crypto";
import { describe, expect, test } from "@/test";
import { FakeSlack } from "@/test/fake-slack";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import devFeedbackRoutes from "./dev-feedback.routes";

describe("POST /api/dev-feedback/comments/:commentId/resolve", () => {
  const ctx = useRouteTestApp(devFeedbackRoutes);
  const server = useMswServer();

  test("marks the Slack message resolved and drops the pin, without reacting", async () => {
    const slack = await enableFeedbackChannel();
    server.use(...slack.handlers());
    const comment = await postComment();

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/dev-feedback/comments/${comment.id}/resolve`,
    });

    expect(response.statusCode).toBe(200);
    const [message] = slack.messages;
    expect(message.reactions).toBeUndefined();
    expect(message.text).toMatch(
      new RegExp(`^:white_check_mark: Resolved by ${ctx.user.name} · `),
    );
    expect(message.metadata?.event_payload).toMatchObject({
      text: "The banner wraps",
      resolvedBy: ctx.user.name,
    });
    const pins = await ctx.app.inject({
      method: "GET",
      url: "/api/dev-feedback/comments?route=/agents",
    });
    expect(pins.json()).toEqual([]);
  });

  test("resolving twice keeps the first resolver", async () => {
    const slack = await enableFeedbackChannel();
    server.use(...slack.handlers());
    const comment = await postComment();
    const [message] = slack.messages;
    message.metadata = {
      event_type: "archestra_dev_feedback_comment",
      event_payload: {
        ...message.metadata?.event_payload,
        resolvedBy: "Someone else",
      },
    };

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/dev-feedback/comments/${comment.id}/resolve`,
    });

    expect(response.statusCode).toBe(200);
    expect(message.metadata.event_payload.resolvedBy).toBe("Someone else");
  });

  test("returns 404 for a message that is not a comment", async () => {
    const slack = await enableFeedbackChannel();
    server.use(...slack.handlers());
    const chatter = slack.addMessage({ text: "lunch?", user: "U1" });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/dev-feedback/comments/${chatter.ts}/resolve`,
    });

    expect(response.statusCode).toBe(404);
  });

  async function postComment(): Promise<{ id: string }> {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload: {
        route: "/agents",
        url: "https://frontend.example.test/agents",
        selector: '[data-testid="agents-table"] > h2:nth-of-type(1)',
        label: 'agents-table › h2 "All agents"',
        elementX: 0.5,
        elementY: 0.5,
        viewportX: 0.5,
        viewportY: 0.5,
        viewport: "1440x900",
        text: "The banner wraps",
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
});

async function enableFeedbackChannel() {
  const slack = new FakeSlack(`C${randomUUID().slice(0, 8)}`);
  await slack.configureAsDevFeedbackChannel();
  return slack;
}
