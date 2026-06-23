import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { SkillSandboxModel } from "@/models";
import ConversationModel from "@/models/conversation";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { fileStore } from "@/skills-sandbox/file-store";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("chat conversation reads — project admin oversight", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let agentId: string;
  let projectConversationId: string;
  let standaloneConversationId: string;
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
    // A file in the project, so the chat Files panel has project content to list.
    const sandbox = await SkillSandboxModel.create({
      organizationId,
      userId: owner.id,
      conversationId: null,
      defaultCwd: "/sandbox",
    });
    await fileStore.put({
      organizationId,
      userId: owner.id,
      projectId: project.id,
      conversationId: null,
      sandboxId: sandbox.id,
      filename: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      data: Buffer.from("hi!"),
    });
    // A standalone (non-project) chat owned by the same other user.
    standaloneConversationId = (
      await ConversationModel.create({
        userId: owner.id,
        organizationId,
        agentId,
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

  test("project admin reads a foreign PROJECT conversation but not a standalone one", async () => {
    const projectRead = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${projectConversationId}`,
    });
    expect(projectRead.statusCode).toBe(200);

    // The seam is project-scoped only: a standalone chat the admin doesn't own
    // is NOT leaked (this prevents project:admin becoming blanket org-chat-read).
    const standaloneRead = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${standaloneConversationId}`,
    });
    expect(standaloneRead.statusCode).toBe(404);
  });

  test("the chat Files panel lists the project's files for a project admin", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${projectConversationId}/files`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ projectFiles: Array<{ name: string }> }>();
    expect(body.projectFiles.map((f) => f.name)).toContain("report.txt");
  });

  test("project admin cannot fork (copy) a foreign project conversation", async () => {
    // Fork is a write path (it copies messages into a new admin-owned chat); it
    // keeps the strict helper, so oversight read access does not enable it.
    const fork = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${projectConversationId}/fork`,
      payload: { agentId },
    });
    expect(fork.statusCode).toBe(404);
  });
});
