import type { ResourcePermissionGrant } from "@archestra/shared";
import ConversationModel from "@/models/conversation";
import MessageModel from "@/models/message";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { ResourcePermissions } from "@/services/resource-permissions";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// A chat is shared through its permission policy. These pin what a recipient
// can do with one: read it, and fork it into a chat of their own.
describe("shared chats", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    currentUser = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: typeof currentUser }).user =
        currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: chatRoutes } = await import("./routes");
    await app.register(chatRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function grant(params: {
    resource: "conversation" | "project";
    scope: string;
    grants: ResourcePermissionGrant[];
  }) {
    const key = {
      organizationId,
      resource: params.resource,
      scope: params.scope,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [...(policy?.grants ?? []), ...params.grants],
    });
  }

  const everyone: ResourcePermissionGrant = {
    subject: { type: "organization", id: "*" },
    actions: ["read"],
  };

  test("refuses to share or fork a policy conversation", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(currentUser.id, organizationId);
    const agent = await makeAgent({ organizationId });
    const conversation = await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId: agent.id,
      origin: "openappa",
    });
    const key = {
      userId: currentUser.id,
      organizationId,
      resource: "conversation" as const,
      scope: conversation.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await expect(
      ResourcePermissions.updatePolicy({
        ...key,
        revision: policy?.revision ?? 0,
        grants: [...(policy?.grants ?? []), everyone],
      }),
    ).rejects.toThrow("Policy conversations cannot be shared");

    const fork = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/fork`,
      payload: { agentId: agent.id },
    });
    expect(fork.statusCode).toBe(400);
  });

  test("a chat shared with named people stays hidden from everyone else", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const owner = currentUser;
    const invitedUser = await makeUser();
    const outsider = await makeUser();
    await makeMember(owner.id, organizationId);
    await makeMember(invitedUser.id, organizationId);
    await makeMember(outsider.id, organizationId);

    const agent = await makeAgent({ organizationId });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: agent.id,
    });
    await grant({
      resource: "conversation",
      scope: conversation.id,
      grants: [
        { subject: { type: "user", id: invitedUser.id }, actions: ["read"] },
      ],
    });

    currentUser = outsider;
    const hidden = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversation.id}`,
    });
    expect(hidden.statusCode).toBe(404);

    currentUser = invitedUser;
    const shown = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversation.id}`,
    });
    expect(shown.statusCode).toBe(200);
    expect(shown.json().share).toEqual({ visibility: "user" });
  });

  test("forks a shared conversation with the original accessible agent", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const owner = currentUser;
    const viewer = await makeUser();
    await makeMember(owner.id, organizationId);
    await makeMember(viewer.id, organizationId);

    const sharedAgent = await makeAgent({ organizationId });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: sharedAgent.id,
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        id: "message-1",
        role: "assistant",
        parts: [{ type: "text", text: "Shared conversation result" }],
      },
    });
    await grant({
      resource: "conversation",
      scope: conversation.id,
      grants: [everyone],
    });

    currentUser = viewer;
    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/fork`,
      payload: { agentId: sharedAgent.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agentId: sharedAgent.id,
      userId: viewer.id,
      messages: [
        expect.objectContaining({
          id: expect.any(String),
          parts: [{ type: "text", text: "Shared conversation result" }],
        }),
      ],
    });
  });

  test("keeps the project link when forking a shared conversation in a project the forker can access", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const owner = currentUser;
    const viewer = await makeUser();
    await makeMember(owner.id, organizationId);
    await makeMember(viewer.id, organizationId);

    const sharedAgent = await makeAgent({ organizationId });
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "shared-project",
      description: null,
    });
    // Share the project org-wide so the viewer can access it (and so a chat
    // started from the shared chat belongs in the project).
    await grant({
      resource: "project",
      scope: project.id,
      grants: [{ ...everyone, actions: ["read", "use"] }],
    });

    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: sharedAgent.id,
      projectId: project.id,
    });
    await grant({
      resource: "conversation",
      scope: conversation.id,
      grants: [everyone],
    });

    currentUser = viewer;
    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/fork`,
      payload: { agentId: sharedAgent.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().projectId).toBe(project.id);
  });

  test("drops the project link when the forker cannot access the source's project", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const owner = currentUser;
    const viewer = await makeUser();
    await makeMember(owner.id, organizationId);
    await makeMember(viewer.id, organizationId);

    const sharedAgent = await makeAgent({ organizationId });
    // Owner-only project: the conversation is shared, but the project is not,
    // so the fork must not attach to a project the viewer cannot see (which
    // would be invisible and unmanageable to them).
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "private-project",
      description: null,
    });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: sharedAgent.id,
      projectId: project.id,
    });
    await grant({
      resource: "conversation",
      scope: conversation.id,
      grants: [everyone],
    });

    currentUser = viewer;
    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/fork`,
      payload: { agentId: sharedAgent.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().projectId).toBeNull();
  });

  test("does not fork a shared conversation with an inaccessible agent", async ({
    makeAgent,
    makeMember,
    makeTeam,
    makeUser,
  }) => {
    const owner = currentUser;
    const viewer = await makeUser();
    await makeMember(owner.id, organizationId);
    await makeMember(viewer.id, organizationId);

    const ownerOnlyTeam = await makeTeam(organizationId, owner.id, {
      name: "Owner Only",
    });
    const sharedAgent = await makeAgent({ organizationId });
    const restrictedAgent = await makeAgent({
      organizationId,
      access: { teams: [ownerOnlyTeam.id] },
    });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: sharedAgent.id,
    });
    await grant({
      resource: "conversation",
      scope: conversation.id,
      grants: [everyone],
    });

    currentUser = viewer;
    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/fork`,
      payload: { agentId: restrictedAgent.id },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Agent not found");
  });
});
