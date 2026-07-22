import ConversationModel from "@/models/conversation";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("conversation enabled-tools routes", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    currentUser = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(currentUser.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: chatRoutes } = await import("./routes");
    await app.register(chatRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns the default selection for an owned conversation", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId: agent.id,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversation.id}/enabled-tools`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      hasCustomSelection: false,
      enabledToolIds: [],
    });
  });

  test("returns 404 for another user's conversation", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId, { role: "member" });
    const agent = await makeAgent({
      organizationId,
      authorId: otherUser.id,
      scope: "personal",
    });
    const conversation = await ConversationModel.create({
      userId: otherUser.id,
      organizationId,
      agentId: agent.id,
    });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversation.id}/enabled-tools`,
    });
    expect(getResponse.statusCode).toBe(404);

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/chat/conversations/${conversation.id}/enabled-tools`,
      payload: { toolIds: ["some-tool"] },
    });
    expect(putResponse.statusCode).toBe(404);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/chat/conversations/${conversation.id}/enabled-tools`,
    });
    expect(deleteResponse.statusCode).toBe(404);
  });
});
