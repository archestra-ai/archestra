import { Activity } from "@microsoft/agents-activity";
import { CloudAdapter, TurnContext } from "@microsoft/agents-hosting";
import { type MockInstance, vi } from "vitest";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import { msTeamsDirectory } from "@/agents/chatops/ms-teams-directory";
import MSTeamsProvider from "@/agents/chatops/ms-teams-provider";
import { createFastifyInstance } from "@/fastify-instance";
import A2AContextModel from "@/models/a2a/context";
import A2AMessageModel from "@/models/a2a/message";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import ChatOpsThreadContextModel from "@/models/chatops-thread-context";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { msTeamsWebhookRoutes } from "./chatops";

describe("Teams conversation addressing", () => {
  setupTestCacheManager();
  let replies: Partial<Activity>[];
  let getMember: MockInstance<typeof msTeamsDirectory.getMember>;

  beforeEach(async ({ makeOrganization }) => {
    await makeOrganization();
    replies = [];
    const provider = new MSTeamsProvider({
      enabled: true,
      appId: "test-bot",
      appSecret: "test-secret",
      tenantId: "test-tenant",
      graphTenantId: "",
      graphClientId: "",
      graphClientSecret: "",
    });
    await provider.initialize();
    vi.spyOn(chatOpsManager, "getMSTeamsProvider").mockReturnValue(provider);

    // Replace only the authenticated Agents SDK transport boundary. The
    // real parser, webhook, addressing cache and database models still run.
    // JWT rejection is covered separately by the real CloudAdapter tests.
    vi.spyOn(CloudAdapter.prototype, "sendActivities").mockImplementation(
      async (_context, activities) => {
        replies.push(...activities);
        return activities.map(() => ({ id: "test-reply" }));
      },
    );
    vi.spyOn(provider, "processActivity").mockImplementation(
      async (req, res, logic) => {
        const adapter = new CloudAdapter();
        await logic(
          new TurnContext(adapter, Activity.fromObject(req.body as object)),
        );
        res.status(200).send();
      },
    );
    getMember = vi.spyOn(msTeamsDirectory, "getMember").mockResolvedValue({
      id: "sender",
      name: "Test Sender",
      email: "sender@example.com",
      userPrincipalName: "sender@example.com",
    });
  });

  afterEach(() => vi.restoreAllMocks());

  async function send(
    conversationType: string,
    text: string,
    options: { mentioned?: string; id?: string; replyToId?: string } = {},
  ) {
    const app = createFastifyInstance();
    await app.register(msTeamsWebhookRoutes);
    try {
      return await app.inject({
        method: "POST",
        url: "/api/webhooks/chatops/ms-teams",
        payload: {
          type: "message",
          id: options.id ?? crypto.randomUUID(),
          text,
          replyToId: options.replyToId,
          channelId: "msteams",
          serviceUrl: "https://smba.trafficmanager.net/amer/",
          from: { id: "sender", name: "Test Sender" },
          recipient: { id: "28:test-bot", name: "Test Bot" },
          conversation: {
            id:
              conversationType === "channel"
                ? "test-chat;messageid=1700000000000"
                : "test-chat",
            conversationType,
          },
          ...(options.mentioned && {
            entities: [
              {
                type: "mention",
                mentioned: { id: options.mentioned, name: "Test Bot" },
              },
            ],
          }),
        },
      });
    } finally {
      await app.close();
    }
  }

  test("group follow-ups stay silent even after a bot mention", async ({
    makeUser,
  }) => {
    await makeUser({ email: "sender@example.com" });
    expect(
      (await send("groupChat", "/status", { mentioned: "TEST-BOT" }))
        .statusCode,
    ).toBe(200);
    expect(replies).toHaveLength(1);
    replies.length = 0;
    getMember.mockClear();

    expect(
      (await send("groupChat", "A follow-up for the group")).statusCode,
    ).toBe(200);
    expect(replies).toEqual([]);
    expect(getMember).not.toHaveBeenCalled();
    expect(
      await ChatOpsChannelBindingModel.findByChannel({
        provider: "ms-teams",
        channelId: "test-chat",
        workspaceId: null,
      }),
    ).toBeNull();
  });

  test("mentioning another participant does not address the bot", async () => {
    expect(
      (await send("groupChat", "For another person", { mentioned: "other" }))
        .statusCode,
    ).toBe(200);
    expect(replies).toEqual([]);
    expect(getMember).not.toHaveBeenCalled();
  });

  test("unmentioned direct messages still receive replies", async ({
    makeUser,
  }) => {
    await makeUser({ email: "sender@example.com" });
    expect((await send("personal", "/status")).statusCode).toBe(200);
    expect(replies).toHaveLength(1);
    expect(getMember).toHaveBeenCalledTimes(1);
  });

  test("group chats honor the explicit answer-all setting", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    await makeUser({ email: "sender@example.com" });
    const binding = await ChatOpsChannelBindingModel.create({
      organizationId: organization.id,
      provider: "ms-teams",
      channelId: "test-chat",
      workspaceId: null,
      agentId: null,
    });
    await ChatOpsChannelBindingModel.update(binding.id, {
      answerAllMessages: true,
    });
    expect((await send("groupChat", "/status")).statusCode).toBe(200);
    expect(replies).toHaveLength(1);
  });

  test("channel threads retain activation after a mention", async ({
    makeUser,
  }) => {
    await makeUser({ email: "sender@example.com" });
    await send("channel", "/status", { id: "1700000000000" });
    expect(replies).toEqual([]);
    await send("channel", "/status", {
      id: "1700000000000",
      mentioned: "28:test-bot",
    });
    expect(replies).toHaveLength(1);
    await send("channel", "/status", { replyToId: "1700000000000" });
    expect(replies).toHaveLength(2);
  });

  test("ambient group text is retained once in the existing shared context", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({
      organizationId: organization.id,
      agentType: "agent",
    });
    await ChatOpsChannelBindingModel.create({
      organizationId: organization.id,
      provider: "ms-teams",
      channelId: "test-chat",
      workspaceId: null,
      agentId: agent.id,
    });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: user.id,
    });
    await ChatOpsThreadContextModel.createOrGet({
      provider: "ms-teams",
      channelId: "test-chat",
      workspaceId: null,
      threadId: "test-chat",
      contextId: context.id,
    });
    const options = { id: "ambient-message", replyToId: "quoted-message" };
    await send("groupChat", "The group context code is ALPHA-42", options);
    await send("groupChat", "The group context code is ALPHA-42", options);

    expect(replies).toEqual([]);
    expect(getMember).not.toHaveBeenCalled();
    const history = await A2AMessageModel.findByContextId(context.id);
    expect(history).toHaveLength(1);
    expect(history[0].content).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: expect.stringContaining("ALPHA-42") }],
    });
    expect(JSON.stringify(history[0].content)).toContain("Test Sender");
  });
});
