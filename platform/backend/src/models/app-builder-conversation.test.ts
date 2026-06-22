import { describe, expect, test } from "@/test";
import AppBuilderConversationModel from "./app-builder-conversation";

type BuilderFixtures = {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  makeAgent: (o: { organizationId: string }) => Promise<{ id: string }>;
  makeConversation: (
    agentId: string,
    o: { userId: string; organizationId: string },
  ) => Promise<{ id: string }>;
  makeApp: (o: {
    organizationId: string;
    authorId: string;
    scope: "personal";
  }) => Promise<{ id: string }>;
};

/** Build an org + user + agent + conversation + app the binding model can wire. */
async function seedBuilder(ctx: BuilderFixtures) {
  const org = await ctx.makeOrganization();
  const user = await ctx.makeUser();
  const agent = await ctx.makeAgent({ organizationId: org.id });
  const conversation = await ctx.makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
  });
  const app = await ctx.makeApp({
    organizationId: org.id,
    authorId: user.id,
    scope: "personal",
  });
  return { org, user, agent, conversation, app };
}

describe("AppBuilderConversationModel.bindDraft", () => {
  test("claims a draft for the created app (first-write-wins)", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
    makeApp,
  }) => {
    const { org, user, conversation, app } = await seedBuilder({
      makeOrganization,
      makeUser,
      makeAgent,
      makeConversation,
      makeApp,
    });
    await AppBuilderConversationModel.createDraft({
      conversationId: conversation.id,
      editorUserId: user.id,
      organizationId: org.id,
    });

    const bound = await AppBuilderConversationModel.bindDraft({
      conversationId: conversation.id,
      appId: app.id,
      editorUserId: user.id,
    });

    expect(bound?.appId).toBe(app.id);
    const reread = await AppBuilderConversationModel.findByConversation(
      conversation.id,
    );
    expect(reread?.appId).toBe(app.id);
  });

  test("is a no-op for an ordinary chat with no draft row", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
    makeApp,
  }) => {
    const { conversation, app, user } = await seedBuilder({
      makeOrganization,
      makeUser,
      makeAgent,
      makeConversation,
      makeApp,
    });

    const bound = await AppBuilderConversationModel.bindDraft({
      conversationId: conversation.id,
      appId: app.id,
      editorUserId: user.id,
    });

    expect(bound).toBeNull();
    expect(
      await AppBuilderConversationModel.findByConversation(conversation.id),
    ).toBeNull();
  });

  test("does not re-bind an already-bound builder", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
    makeApp,
  }) => {
    const { org, user, conversation, app } = await seedBuilder({
      makeOrganization,
      makeUser,
      makeAgent,
      makeConversation,
      makeApp,
    });
    await AppBuilderConversationModel.createDraft({
      conversationId: conversation.id,
      editorUserId: user.id,
      organizationId: org.id,
    });
    await AppBuilderConversationModel.bindDraft({
      conversationId: conversation.id,
      appId: app.id,
      editorUserId: user.id,
    });
    const other = await makeApp({
      organizationId: org.id,
      authorId: user.id,
      scope: "personal",
    });

    const second = await AppBuilderConversationModel.bindDraft({
      conversationId: conversation.id,
      appId: other.id,
      editorUserId: user.id,
    });

    expect(second).toBeNull();
    const reread = await AppBuilderConversationModel.findByConversation(
      conversation.id,
    );
    expect(reread?.appId).toBe(app.id);
  });

  test("does not bind another editor's draft", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
    makeApp,
  }) => {
    const { org, user, conversation, app } = await seedBuilder({
      makeOrganization,
      makeUser,
      makeAgent,
      makeConversation,
      makeApp,
    });
    await AppBuilderConversationModel.createDraft({
      conversationId: conversation.id,
      editorUserId: user.id,
      organizationId: org.id,
    });
    const stranger = await makeUser();

    const bound = await AppBuilderConversationModel.bindDraft({
      conversationId: conversation.id,
      appId: app.id,
      editorUserId: stranger.id,
    });

    expect(bound).toBeNull();
    expect(
      (await AppBuilderConversationModel.findByConversation(conversation.id))
        ?.appId,
    ).toBeNull();
  });
});

describe("AppBuilderConversationModel resume + sever", () => {
  test("findByAppAndEditor resumes the editor's bound builder", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
    makeApp,
  }) => {
    const { org, user, conversation, app } = await seedBuilder({
      makeOrganization,
      makeUser,
      makeAgent,
      makeConversation,
      makeApp,
    });
    await AppBuilderConversationModel.createBound({
      conversationId: conversation.id,
      appId: app.id,
      editorUserId: user.id,
      organizationId: org.id,
    });

    const found = await AppBuilderConversationModel.findByAppAndEditor({
      appId: app.id,
      editorUserId: user.id,
    });
    expect(found?.conversationId).toBe(conversation.id);
  });

  test("at most one builder per (app, editor)", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
    makeApp,
  }) => {
    const { org, user, agent, conversation, app } = await seedBuilder({
      makeOrganization,
      makeUser,
      makeAgent,
      makeConversation,
      makeApp,
    });
    await AppBuilderConversationModel.createBound({
      conversationId: conversation.id,
      appId: app.id,
      editorUserId: user.id,
      organizationId: org.id,
    });
    const second = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });

    await expect(
      AppBuilderConversationModel.createBound({
        conversationId: second.id,
        appId: app.id,
        editorUserId: user.id,
        organizationId: org.id,
      }),
    ).rejects.toThrow();
  });

  test("severForApp removes the binding", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
    makeApp,
  }) => {
    const { org, user, conversation, app } = await seedBuilder({
      makeOrganization,
      makeUser,
      makeAgent,
      makeConversation,
      makeApp,
    });
    await AppBuilderConversationModel.createBound({
      conversationId: conversation.id,
      appId: app.id,
      editorUserId: user.id,
      organizationId: org.id,
    });

    await AppBuilderConversationModel.severForApp(app.id);

    expect(
      await AppBuilderConversationModel.findByAppAndEditor({
        appId: app.id,
        editorUserId: user.id,
      }),
    ).toBeNull();
  });
});
