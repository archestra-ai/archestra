import { ADMIN_ROLE_NAME, SEEDED_APP_RENDER_META_KEY } from "@archestra/shared";
import { ConversationModel, MemberModel, MessageModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("POST /api/apps/external/:mcpServerId/open-in-chat", () => {
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

  test("seeds a conversation rendering the install's ui resource via the server endpoint", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Archestra PM",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const install = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "show_board",
      meta: { _meta: { ui: { resourceUri: "ui://pm/board.html" } } },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/external/${install.id}/open-in-chat`,
      payload: { resourceUri: "ui://pm/board.html" },
    });
    expect(res.statusCode).toBe(200);
    const { conversationId, mode, prompt } = res.json();
    expect(conversationId).toBeTruthy();
    expect(mode).toBe("render");
    expect(prompt).toBeUndefined();

    const messages = await MessageModel.findByConversation(conversationId);
    // External apps are read-only from chat, so no greeting.
    expect(messages).toHaveLength(1);
    const part = messages[0].content.parts[0] as {
      type: string;
      state: string;
      output: {
        _meta: {
          ui: { resourceUri: string; mcpServerId: string };
          [SEEDED_APP_RENDER_META_KEY]?: boolean;
        };
      };
    };
    expect(part.type).toBe("dynamic-tool");
    expect(part.state).toBe("output-available");
    // The UI pointer plus the concrete install so the chat mounts via
    // /api/mcp/server/<id> independent of the conversation's agent.
    expect(part.output._meta.ui).toEqual({
      resourceUri: "ui://pm/board.html",
      mcpServerId: install.id,
    });
    // The platform-authored marker keeps the seeded render from being treated
    // as untrusted external tool output (which would flip the whole new
    // conversation to sensitive context before the user ever sends a message).
    expect(part.output._meta[SEEDED_APP_RENDER_META_KEY]).toBe(true);
  });

  test("returns prompt mode (empty conversation) when the tool has required inputs", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Atlassian",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const install = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
    });
    // Rendering this tool with input {} cannot succeed, so opening it must go
    // through a model turn that collects the inputs first.
    await makeTool({
      catalogId: catalog.id,
      name: "createjiraissue",
      parameters: {
        type: "object",
        properties: {
          projectKey: { type: "string" },
          summary: { type: "string" },
        },
        required: ["projectKey", "summary"],
      },
      meta: { _meta: { ui: { resourceUri: "ui://jira/create-issue.html" } } },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/external/${install.id}/open-in-chat`,
      payload: { resourceUri: "ui://jira/create-issue.html" },
    });
    expect(res.statusCode).toBe(200);
    const { conversationId, mode, prompt } = res.json();
    expect(mode).toBe("prompt");
    // The opening prompt names the app so the agent can find and call the tool.
    expect(prompt).toContain("Atlassian / createjiraissue");

    // No seeded render: the client sends `prompt` as the first user message,
    // which triggers the model turn.
    const messages = await MessageModel.findByConversation(conversationId);
    expect(messages).toHaveLength(0);

    // Same conversation title as the seeded-render mode.
    const conversation = await ConversationModel.findById({
      id: conversationId,
      userId: user.id,
      organizationId,
    });
    expect(conversation?.title).toBe("Atlassian / createjiraissue");
  });

  test("seeds the render when the tool's inputs are all optional", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Archestra PM",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const install = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "show_board",
      parameters: {
        type: "object",
        properties: { filter: { type: "string" } },
      },
      meta: { _meta: { ui: { resourceUri: "ui://pm/board.html" } } },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/external/${install.id}/open-in-chat`,
      payload: { resourceUri: "ui://pm/board.html" },
    });
    expect(res.statusCode).toBe(200);
    const { conversationId, mode } = res.json();
    expect(mode).toBe("render");
    expect(await MessageModel.findByConversation(conversationId)).toHaveLength(
      1,
    );
  });

  test("404s for an install the caller cannot access", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/external/${crypto.randomUUID()}/open-in-chat`,
      payload: { resourceUri: "ui://pm/board.html" },
    });
    expect(res.statusCode).toBe(404);
  });

  test("404s when the install exposes no matching ui resource", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Archestra PM",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const install = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "show_board",
      meta: { _meta: { ui: { resourceUri: "ui://pm/board.html" } } },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/external/${install.id}/open-in-chat`,
      payload: { resourceUri: "ui://pm/does-not-exist.html" },
    });
    expect(res.statusCode).toBe(404);
  });
});
