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

describe("POST /api/apps/:appId/open-in-chat", () => {
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

  async function createApp(name: string): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name },
    });
    expect(created.statusCode).toBe(200);
    return created.json().id;
  }

  // The seeded conversation carries a render_app message — a dynamic-tool result
  // whose structuredContent.id is the app id — alongside a Build App skill preload
  // (a load_skill message). This locates the render and returns its rendered app id.
  function expectSeededRender(
    messages: Array<{
      role: string;
      content: { parts: Array<Record<string, unknown>> };
    }>,
  ) {
    const renders = messages
      .filter((m) => m.role === "assistant")
      .map(
        (m) =>
          m.content.parts[0] as {
            type: string;
            toolName: string;
            state: string;
            output: { structuredContent?: { id: string } };
          },
      )
      .filter((part) => part.toolName?.includes("render_app"));
    expect(renders).toHaveLength(1);
    const [part] = renders;
    expect(part.type).toBe("dynamic-tool");
    expect(part.state).toBe("output-available");
    return part.output.structuredContent?.id;
  }

  test("seeds a conversation with the app rendered and returns its id", async () => {
    const appId = await createApp("Notes");

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/open-in-chat`,
    });
    expect(res.statusCode).toBe(200);
    const { conversationId } = res.json();
    expect(conversationId).toBeTruthy();

    const messages = await MessageModel.findByConversation(conversationId);
    expect(expectSeededRender(messages)).toBe(appId);
  });

  test("create with openInChat returns the seeded conversation id", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Inline", openInChat: true },
    });
    expect(created.statusCode).toBe(200);
    const { id, conversationId } = created.json();
    expect(conversationId).toBeTruthy();

    const messages = await MessageModel.findByConversation(conversationId);
    expect(expectSeededRender(messages)).toBe(id);
  });

  test("404s for an app the caller cannot view", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${crypto.randomUUID()}/open-in-chat`,
    });
    expect(res.statusCode).toBe(404);
  });
});
