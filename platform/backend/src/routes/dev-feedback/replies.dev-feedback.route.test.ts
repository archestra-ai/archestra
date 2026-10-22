import { randomUUID } from "node:crypto";
import { describe, expect, test } from "@/test";
import { FakeSlack } from "@/test/fake-slack";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import devFeedbackRoutes from "./dev-feedback.routes";

describe("/api/dev-feedback/comments/:commentId/replies", () => {
  const ctx = useRouteTestApp(devFeedbackRoutes);
  const server = useMswServer();

  test("a reply from the page and a reply typed in Slack read back in thread order", async () => {
    const slack = new FakeSlack(`C${randomUUID().slice(0, 8)}`);
    await slack.configureAsDevFeedbackChannel();
    server.use(...slack.handlers());
    slack.users.set("U1", "Grace");
    const comment = addComment(slack);
    slack.addMessage({ text: "looking", user: "U1", threadTs: comment.ts });

    const posted = await ctx.app.inject({
      method: "POST",
      url: `/api/dev-feedback/comments/${comment.ts}/replies`,
      payload: { text: "thanks <3" },
    });
    expect(posted.statusCode).toBe(200);
    expect(slack.messages.at(-1)?.text).toBe(
      `*${ctx.user.name}:* thanks &lt;3`,
    );

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/dev-feedback/comments/${comment.ts}/replies`,
    });

    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .map((reply: { authorName: string; text: string }) => [
          reply.authorName,
          reply.text,
        ]),
    ).toEqual([
      ["Grace", "looking"],
      [ctx.user.name, "thanks <3"],
    ]);
  });

  test("does not read or answer threads that are not feedback comments", async () => {
    const slack = new FakeSlack(`C${randomUUID().slice(0, 8)}`);
    await slack.configureAsDevFeedbackChannel();
    server.use(...slack.handlers());
    const chatter = slack.addMessage({ text: "lunch?", user: "U1" });
    slack.addMessage({ text: "sure", user: "U2", threadTs: chatter.ts });

    const read = await ctx.app.inject({
      method: "GET",
      url: `/api/dev-feedback/comments/${chatter.ts}/replies`,
    });
    const answered = await ctx.app.inject({
      method: "POST",
      url: `/api/dev-feedback/comments/${chatter.ts}/replies`,
      payload: { text: "me too" },
    });

    expect(read.statusCode).toBe(404);
    expect(answered.statusCode).toBe(404);
    expect(slack.messages).toHaveLength(2);
  });
});

function addComment(slack: FakeSlack) {
  return slack.addMessage({
    text: "pinned comment",
    botId: "B1",
    metadata: {
      event_type: "archestra_dev_feedback_comment",
      event_payload: { route: "/agents", text: "pinned comment" },
    },
  });
}
