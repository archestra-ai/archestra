import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { runScopedResourcePermissionCutover } from "@/services/resource-permissions-cutover";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * A chat turn is authorized by the agent's own grant. Before scoped
 * permissions existed, reaching an organization-wide agent asked nothing of
 * the caller's role — only the object lists and the model catalog were
 * role-gated — so a role shaped for chat alone could chat. An upgrade has to
 * leave that caller where it found them, while a grant taken away afterwards
 * has to take the chat with it.
 */
describe("POST /api/chat agent use permission", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let agentId: string;
  let conversationId: string;

  beforeEach(
    async ({
      makeAgent,
      makeConversation,
      makeCustomRole,
      makeMember,
      makeOrganization,
      makeUser,
    }) => {
      // An organization as it stood before the cutover: visibility fields, no
      // grants, and a role that can chat and nothing else.
      const organization = await makeOrganization({ legacyPermissions: true });
      organizationId = organization.id;
      user = await makeUser();
      const role = await makeCustomRole(organizationId, {
        permission: { chat: ["read", "create"] },
      });
      await makeMember(user.id, organizationId, { role: role.role });
      const agent = await makeAgent({
        organizationId,
        name: "Org-wide agent",
        agentType: "agent",
        scope: "org",
      });
      agentId = agent.id;
      conversationId = (
        await makeConversation(agentId, { userId: user.id, organizationId })
      ).id;
      await runScopedResourcePermissionCutover();

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = user;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = organizationId;
      });
      const { default: chatRoutes } = await import("./routes");
      await app.register(chatRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  const startChat = () =>
    app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          { id: "msg-1", role: "user", parts: [{ type: "text", text: "Hi" }] },
        ],
      },
    });

  test("a role that can only chat keeps the agent the upgrade found it using", async () => {
    const response = await startChat();

    // No LLM provider is configured here, so the turn cannot get far. What
    // this pins is the door: authorization, not the model that is missing.
    expect(response.statusCode).not.toBe(403);
    expect(response.json().error).toMatchObject({
      type: expect.not.stringContaining("authorization"),
    });
  });

  test("revoking the agent's grant stops the conversation it already had", async () => {
    const key = { organizationId, resource: "agent" as const, scope: agentId };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [],
    });

    expect((await startChat()).statusCode).toBe(403);
  });
});
