import { randomUUID } from "node:crypto";
import config from "@/config";
import { describe, expect, test } from "@/test";
import { FakeSlack } from "@/test/fake-slack";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import devFeedbackRoutes from "./dev-feedback.routes";

describe("dev feedback setup", () => {
  const ctx = useRouteTestApp(devFeedbackRoutes);
  const server = useMswServer();

  test("every endpoint 404s, without calling Slack, when the flag is off", async () => {
    const slack = new FakeSlack(channelId());
    await slack.configureAsDevFeedbackChannel();
    const comment = slack.addMessage({ text: "pinned", botId: "B1" });
    // Any Slack call would fail the test: msw rejects unhandled requests.
    config.devFeedback.enabled = false;

    const requests = [
      { method: "GET", url: "/api/dev-feedback/setup" },
      { method: "GET", url: "/api/dev-feedback/setup/bots" },
      { method: "GET", url: "/api/dev-feedback/setup/bots/A1/channels" },
      { method: "PUT", url: "/api/dev-feedback/setup" },
      { method: "GET", url: "/api/dev-feedback/comments?route=/agents" },
      { method: "POST", url: "/api/dev-feedback/comments" },
      {
        method: "GET",
        url: `/api/dev-feedback/comments/${comment.ts}/replies`,
      },
      {
        method: "POST",
        url: `/api/dev-feedback/comments/${comment.ts}/replies`,
      },
      {
        method: "POST",
        url: `/api/dev-feedback/comments/${comment.ts}/resolve`,
      },
    ] as const;
    for (const request of requests) {
      const response = await ctx.app.inject({
        ...request,
        payload: request.method === "GET" ? undefined : { anything: true },
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
    }
    expect(slack.messages).toHaveLength(1);
  });

  test("reports not set up until a bot and channel are picked", async () => {
    const slack = new FakeSlack(channelId());
    server.use(...slack.handlers());
    await slack.connectChatOpsBot();

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/dev-feedback/setup",
    });

    expect(response.json()).toEqual({ configured: false, channelName: null });
  });

  test("offers the chatops bots by their Slack name", async () => {
    const slack = new FakeSlack(channelId());
    server.use(...slack.handlers());
    await slack.connectChatOpsBot();

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/dev-feedback/setup/bots",
    });

    expect(response.json()).toEqual([{ id: "A1", name: "feedback-bot" }]);
  });

  test("lists public channels and only the private ones the bot is in", async () => {
    const slack = new FakeSlack(channelId());
    slack.channels.push(
      { id: "C2", name: "general", isPrivate: false, isMember: false },
      { id: "G1", name: "secret", isPrivate: true, isMember: false },
      { id: "G2", name: "design-review", isPrivate: true, isMember: true },
    );
    server.use(...slack.handlers());
    await slack.connectChatOpsBot();

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/dev-feedback/setup/bots/A1/channels",
    });

    expect(response.json()).toEqual([
      { id: "G2", name: "design-review", isPrivate: true },
      { id: "C2", name: "general", isPrivate: false },
      { id: slack.channel, name: "ui-feedback", isPrivate: false },
    ]);
  });

  test("saving joins a public channel, and comments then go there", async () => {
    const slack = new FakeSlack(channelId());
    slack.channels[0].isMember = false;
    server.use(...slack.handlers());
    await slack.connectChatOpsBot();

    const saved = await ctx.app.inject({
      method: "PUT",
      url: "/api/dev-feedback/setup",
      payload: { botId: "A1", channelId: slack.channel },
    });

    expect(saved.json()).toEqual({
      configured: true,
      channelName: "ui-feedback",
    });
    expect(slack.channels[0].isMember).toBe(true);
    const comment = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload: {
        route: "/agents",
        url: "https://frontend.example.test/agents",
        selector: "main > h1:nth-of-type(1)",
        label: 'h1 "Agents"',
        elementX: 0.5,
        elementY: 0.5,
        viewportX: 0.5,
        viewportY: 0.5,
        viewport: "1440x900",
        text: "Title is cut off",
      },
    });
    expect(comment.statusCode).toBe(200);
    expect(slack.messages).toHaveLength(1);
  });

  test("refuses a private channel the bot was not invited to", async () => {
    const slack = new FakeSlack(channelId());
    slack.channels.push({
      id: "G1",
      name: "secret",
      isPrivate: true,
      isMember: false,
    });
    server.use(...slack.handlers());
    await slack.connectChatOpsBot();

    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/dev-feedback/setup",
      payload: { botId: "A1", channelId: "G1" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("invite the bot first");
  });

  test("refuses a bot that is not a chatops bot", async () => {
    const slack = new FakeSlack(channelId());
    server.use(...slack.handlers());
    await slack.connectChatOpsBot();

    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/dev-feedback/setup",
      payload: { botId: "A999", channelId: slack.channel },
    });

    expect(response.statusCode).toBe(404);
  });
});

function channelId() {
  return `C${randomUUID().slice(0, 8).toUpperCase()}`;
}
