import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import { MemberModel, MessageModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import type { User } from "@/types";

describe("POST /api/apps/external/:mcpServerId/open-in-chat", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  const appsEnabled = config.apps.enabled;
  beforeAll(() => {
    (config.apps as { enabled: boolean }).enabled = true;
  });
  afterAll(() => {
    (config.apps as { enabled: boolean }).enabled = appsEnabled;
  });

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
    const { conversationId } = res.json();
    expect(conversationId).toBeTruthy();

    const messages = await MessageModel.findByConversation(conversationId);
    // External apps are read-only from chat, so no greeting.
    expect(messages).toHaveLength(1);
    const part = messages[0].content.parts[0] as {
      type: string;
      state: string;
      output: { _meta: { ui: { resourceUri: string; mcpServerId: string } } };
    };
    expect(part.type).toBe("dynamic-tool");
    expect(part.state).toBe("output-available");
    // The UI pointer plus the concrete install so the chat mounts via
    // /api/mcp/server/<id> independent of the conversation's agent.
    expect(part.output._meta.ui).toEqual({
      resourceUri: "ui://pm/board.html",
      mcpServerId: install.id,
    });
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
