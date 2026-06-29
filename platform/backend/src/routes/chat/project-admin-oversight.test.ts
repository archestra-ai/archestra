import { ADMIN_ROLE_NAME } from "@archestra/shared";
import ConversationModel from "@/models/conversation";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * Chats are hidden from project oversight: holding `project:admin` lets you
 * manage a foreign project and its files, but NEVER read, list the files of, or
 * fork its chats. These guard that boundary at the chat-route level (the project
 * detail page hides the Chats panel; the backend must independently refuse too).
 */
describe("chat reads — hidden from project admins", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let agentId: string;
  let projectConversationId: string;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    organizationId = (await makeOrganization()).id;

    const owner = await makeUser();
    await makeMember(owner.id, organizationId, {});
    agentId = (
      await makeAgent({ organizationId, authorId: owner.id, scope: "org" })
    ).id;

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "chat-oversight",
      description: null,
    });
    projectConversationId = (
      await ConversationModel.create({
        userId: owner.id,
        organizationId,
        agentId,
        projectId: project.id,
      })
    ).id;

    const admin = await makeUser({ email: "chat-oversight-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    actingUser = admin;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = actingUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    const { default: chatRoutes } = await import("./routes");
    await app.register(chatRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("a project admin cannot read, list files of, or fork a foreign project chat", async () => {
    const read = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${projectConversationId}`,
    });
    expect(read.statusCode).toBe(404);

    const files = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${projectConversationId}/files`,
    });
    expect(files.statusCode).toBe(404);

    // Fork is a write path regardless; it stays owner/share-gated.
    const fork = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${projectConversationId}/fork`,
      payload: { agentId },
    });
    expect(fork.statusCode).toBe(404);
  });
});
