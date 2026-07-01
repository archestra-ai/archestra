import ConversationModel from "@/models/conversation";
import FileModel from "@/models/file";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { fileStore } from "@/skills-sandbox/file-store";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("POST /api/projects/from-conversation", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let agentId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeAgent }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    agentId = (await makeAgent({ organizationId })).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    const { default: projectRoutes } = await import("./project.routes");
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates a project from the chat and moves its files in", async ({
    makeConversation,
  }) => {
    const conv = await makeConversation(agentId, {
      userId: user.id,
      organizationId,
      title: "Weekly digest",
    });
    await fileStore.put({
      organizationId,
      userId: user.id,
      projectId: null,
      conversationId: conv.id,
      filename: "summary.md",
      mimeType: "text/plain",
      sizeBytes: 3,
      data: Buffer.from("abc"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/from-conversation",
      payload: { conversationId: conv.id },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ id: string; name: string }>();
    expect(body).toMatchObject({
      name: "Weekly digest",
      viewerRole: "owner",
      conversationCount: 1,
    });

    const meta = await ConversationModel.getOwnedMeta({
      id: conv.id,
      userId: user.id,
      organizationId,
    });
    expect(meta?.projectId).toBe(body.id);
    const projectFiles = await FileModel.listByProject({
      organizationId,
      projectId: body.id,
    });
    expect(projectFiles).toHaveLength(1);
  });

  test("404s for a conversation the caller does not own", async ({
    makeUser,
    makeConversation,
  }) => {
    const someoneElse = await makeUser();
    const conv = await makeConversation(agentId, {
      userId: someoneElse.id,
      organizationId,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/from-conversation",
      payload: { conversationId: conv.id },
    });
    expect(response.statusCode).toBe(404);
  });

  test("409s when the chat already belongs to a project", async ({
    makeConversation,
  }) => {
    const conv = await makeConversation(agentId, {
      userId: user.id,
      organizationId,
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/projects/from-conversation",
      payload: { conversationId: conv.id },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/projects/from-conversation",
      payload: { conversationId: conv.id },
    });
    expect(second.statusCode).toBe(409);
  });

  test("rejects a malformed conversation id with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/from-conversation",
      payload: { conversationId: "not-a-uuid" },
    });
    expect(response.statusCode).toBe(400);
  });
});
