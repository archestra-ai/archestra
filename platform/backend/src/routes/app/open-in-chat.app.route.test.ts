import { ADMIN_ROLE_NAME } from "@archestra/shared";
import {
  AgentModel,
  AppModel,
  ConversationModel,
  MemberModel,
  MessageModel,
  OrganizationModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("POST /api/apps/:appId/open-in-chat", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let memberDefaultAgentId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    // The seeded conversation binds to the caller's default chat agent.
    const agent = await makeAgent({ organizationId, agentType: "agent" });
    memberDefaultAgentId = agent.id;
    await MemberModel.setDefaultAgent(user.id, organizationId, agent.id);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: appRoutes } = await import("./app.routes");
    await app.register(appRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function createApp(
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name, ...extra },
    });
    expect(created.statusCode).toBe(200);
    return created.json().id;
  }

  // Forks a new version (latestVersion 1 → 2).
  async function editApp(appId: string): Promise<void> {
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/apps/${appId}`,
      payload: { html: "<h1>edited</h1>" },
    });
    expect(edited.statusCode).toBe(200);
  }

  // The seeded message is what makes the app render inline with no model turn —
  // a dynamic-tool render_app result whose structuredContent.id is the app id.
  function expectSeededRender(message: {
    role: string;
    content: { parts: Array<Record<string, unknown>> };
  }) {
    expect(message.role).toBe("assistant");
    const part = message.content.parts[0] as {
      type: string;
      toolName: string;
      state: string;
      output: { structuredContent: { id: string } };
    };
    expect(part.type).toBe("dynamic-tool");
    expect(part.toolName).toContain("render_app");
    expect(part.state).toBe("output-available");
    return part.output.structuredContent.id;
  }

  function expectSeededGreeting(
    message: {
      role: string;
      content: { parts: Array<Record<string, unknown>> };
    },
    appName: string,
  ): string {
    expect(message.role).toBe("assistant");
    const part = message.content.parts[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    // The greeting names the app.
    expect(part.text).toContain(appName);
    return part.text;
  }

  test("seeds a render plus a greeting for an app built past the scaffold", async () => {
    const appId = await createApp("Notes");
    await editApp(appId);

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/open-in-chat`,
    });
    expect(res.statusCode).toBe(200);
    const { conversationId } = res.json();
    expect(conversationId).toBeTruthy();

    const messages = await MessageModel.findByConversation(conversationId);
    expect(messages).toHaveLength(2);
    expect(expectSeededRender(messages[0])).toBe(appId);
    expectSeededGreeting(messages[1], "Notes");

    // Seeded as an `app_open` draft: hidden from the conversations list until
    // the user writes into it (ConversationModel.findAll).
    const conversation = await ConversationModel.findById({
      id: conversationId,
      userId: user.id,
      organizationId,
    });
    expect(conversation?.origin).toBe("app_open");
    // The app name is only a stand-in, so the first settled exchange retitles
    // the chat instead of leaving it named after the app forever.
    expect(conversation?.title).toBe("Notes");
    expect(conversation?.titleIsPlaceholder).toBe(true);
  });

  test("seeds a render plus a greeting for a brand-new scaffold app", async () => {
    const appId = await createApp("Fresh");

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/open-in-chat`,
    });
    const { conversationId } = res.json();

    const messages = await MessageModel.findByConversation(conversationId);
    expect(messages).toHaveLength(2);
    expect(expectSeededRender(messages[0])).toBe(appId);
    expectSeededGreeting(messages[1], "Fresh");
  });

  test("create with openInChat seeds a render plus a greeting", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Inline", openInChat: true },
    });
    expect(created.statusCode).toBe(200);
    const { id, conversationId } = created.json();
    expect(conversationId).toBeTruthy();

    const messages = await MessageModel.findByConversation(conversationId);
    expect(messages).toHaveLength(2);
    expect(expectSeededRender(messages[0])).toBe(id);
    expectSeededGreeting(messages[1], "Inline");
  });

  test("the seeded greeting omits the app description", async () => {
    const id = await createApp("Tracker", { description: "Track team spend." });
    await editApp(id);

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/open-in-chat`,
    });
    const { conversationId } = res.json();

    const messages = await MessageModel.findByConversation(conversationId);
    expect(messages).toHaveLength(2);
    const greeting = expectSeededGreeting(messages[1], "Tracker");
    expect(greeting).not.toContain("Track team spend.");
  });

  async function openInChat(appId: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/open-in-chat`,
    });
    expect(res.statusCode).toBe(200);
    return res.json().conversationId;
  }

  test("binds the seeded conversation to the org default agent when one is configured", async ({
    makeAgent,
  }) => {
    // The org default outranks the member's personal default, mirroring /chat.
    const orgDefault = await makeAgent({ organizationId, agentType: "agent" });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: orgDefault.id,
    });

    const appId = await createApp("OrgDefault");
    const conversationId = await openInChat(appId);

    expect(await ConversationModel.getAgentId(conversationId)).toBe(
      orgDefault.id,
    );
  });

  test("binds to the caller's member default agent when no org default is configured", async () => {
    const appId = await createApp("MemberDefault");
    const conversationId = await openInChat(appId);

    expect(await ConversationModel.getAgentId(conversationId)).toBe(
      memberDefaultAgentId,
    );
  });

  test("bootstraps a personal chat agent for a caller with no defaults anywhere", async ({
    makeUser,
    makeMember,
  }) => {
    // Fresh member: no org default, no member default. The onRequest hook reads
    // the outer `user` at request time, so reassigning switches the caller.
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    const appId = await createApp("Bootstrap");
    const conversationId = await openInChat(appId);

    const agentId = await ConversationModel.getAgentId(conversationId);
    expect(agentId).toBe(
      await MemberModel.getDefaultAgentId(user.id, organizationId),
    );
    const agent = await AgentModel.findById(agentId as string);
    expect(agent?.name).toBe("My Assistant");
    expect(agent?.scope).toBe("personal");
  });

  test("falls back to the member default when the org default agent is soft-deleted", async ({
    makeAgent,
  }) => {
    const orgDefault = await makeAgent({ organizationId, agentType: "agent" });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: orgDefault.id,
    });
    await AgentModel.delete(orgDefault.id);

    const appId = await createApp("DeletedDefault");
    const conversationId = await openInChat(appId);

    expect(await ConversationModel.getAgentId(conversationId)).toBe(
      memberDefaultAgentId,
    );
  });

  test("falls back to the member default when the org default is not a chat agent", async ({
    makeAgent,
  }) => {
    // Only internal chat agents appear in the /chat picker; a gateway pointed
    // at by the org default must not capture app-opened conversations.
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: gateway.id,
    });

    const appId = await createApp("GatewayDefault");
    const conversationId = await openInChat(appId);

    expect(await ConversationModel.getAgentId(conversationId)).toBe(
      memberDefaultAgentId,
    );
  });

  test("falls back to the member default when the org default agent is built-in", async ({
    makeAgent,
  }) => {
    // `builtIn` is a generated column: true iff builtInAgentConfig is set.
    const builtIn = await makeAgent({
      organizationId,
      agentType: "agent",
      builtInAgentConfig: { name: "chat-title-generation-subagent" },
    });
    expect(builtIn.builtIn).toBe(true);
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: builtIn.id,
    });

    const appId = await createApp("BuiltInDefault");
    const conversationId = await openInChat(appId);

    expect(await ConversationModel.getAgentId(conversationId)).toBe(
      memberDefaultAgentId,
    );
  });

  test("falls back to the member default when the org default agent belongs to another organization", async ({
    makeOrganization,
    makeAgent,
  }) => {
    // An org-scoped agent passes the access check for any caller, so the
    // same-org guard is the only thing keeping a cross-org default out.
    const otherOrg = await makeOrganization();
    const foreignAgent = await makeAgent({
      organizationId: otherOrg.id,
      agentType: "agent",
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: foreignAgent.id,
    });

    const appId = await createApp("CrossOrgDefault");
    const conversationId = await openInChat(appId);

    expect(await ConversationModel.getAgentId(conversationId)).toBe(
      memberDefaultAgentId,
    );
  });

  test("falls back to the member default when the org default agent is another user's personal agent", async ({
    makeUser,
    makeAgent,
  }) => {
    const other = await makeUser();
    const foreignPersonal = await makeAgent({
      organizationId,
      agentType: "agent",
      scope: "personal",
      authorId: other.id,
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: foreignPersonal.id,
    });

    const appId = await createApp("ForeignDefault");
    const conversationId = await openInChat(appId);

    expect(await ConversationModel.getAgentId(conversationId)).toBe(
      memberDefaultAgentId,
    );
  });

  test("404s for an app the caller cannot view", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${crypto.randomUUID()}/open-in-chat`,
    });
    expect(res.statusCode).toBe(404);
  });

  test("404s for a disabled app, even for its author", async () => {
    const id = await createApp("Paused");
    await AppModel.setEnabled(id, false);

    // Seeding would hand the conversation the very app every chat tool
    // refuses to acknowledge — a disabled app cannot enter chat at all.
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/open-in-chat`,
    });
    expect(res.statusCode).toBe(404);
  });
});
