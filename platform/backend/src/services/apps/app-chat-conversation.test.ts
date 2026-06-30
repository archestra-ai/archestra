import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import { MessageModel } from "@/models";
import { afterAll, beforeAll, describe, expect, test } from "@/test";
import { createSeededAppConversation } from "./app-chat-conversation";

describe("createSeededAppConversation", () => {
  const appsEnabled = config.apps.enabled;
  beforeAll(() => {
    (config.apps as { enabled: boolean }).enabled = true;
  });
  afterAll(() => {
    (config.apps as { enabled: boolean }).enabled = appsEnabled;
  });

  test("preloads the Build App skill alongside the render_app seed", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const app = await makeApp({
      organizationId: org.id,
      authorId: user.id,
      scope: "personal",
    });

    const { conversationId } = await createSeededAppConversation({
      appId: app.id,
      userId: user.id,
      organizationId: org.id,
    });

    const messages = await MessageModel.findByConversation(conversationId);
    const parts = messages.map(
      // biome-ignore lint/suspicious/noExplicitAny: content is $type<any>
      (m) => (m.content as any).parts[0],
    );
    const loadSkill = parts.find((p) => p.toolName?.endsWith("load_skill"));
    const renderApp = parts.find((p) => p.toolName?.endsWith("render_app"));

    // Both the skill preload and the app render are seeded with no model turn.
    expect(renderApp).toBeDefined();
    expect(loadSkill).toBeDefined();
    // The preload carries the window.archestra SDK contract, so the model's first
    // edit_app on this UI-created app has it without calling load_skill itself.
    const text = loadSkill.output.content[0].text as string;
    expect(text).toContain('<skill_content name="Build App">');
    expect(text).toContain("archestra.storage.user");
  });
});
