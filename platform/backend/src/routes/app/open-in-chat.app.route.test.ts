import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { MemberModel, MessageModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("POST /api/apps/:appId/open-in-chat", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    // The seeded conversation binds to the caller's default chat agent.
    const agent = await makeAgent({ organizationId });
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
    expect(part.text).toContain(appName);
    expect(part.text).toContain("Want to change the app? Tell me how!");
    expect(part.text).toContain(
      "Want to use the app? Use the UI 👉, or ask me to!",
    );
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

  test("404s for an app the caller cannot view", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${crypto.randomUUID()}/open-in-chat`,
    });
    expect(res.statusCode).toBe(404);
  });
});
