import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AgentModel, AuditLogModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import agentRoutes from "./agent";

describe("POST /api/agents/:id/transfer-ownership", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let recipient: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    recipient = await makeUser();
    await makeMember(user.id, organizationId, { role: MEMBER_ROLE_NAME });
    await makeMember(recipient.id, organizationId, { role: MEMBER_ROLE_NAME });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(agentRoutes);
  });
  afterEach(async () => {
    await app.close();
  });

  const transfer = (id: string, ownerId = recipient.id) =>
    app.inject({
      method: "POST",
      url: `/api/agents/${id}/transfer-ownership`,
      payload: { ownerId },
    });

  test("transfers a personal agent's access and records the ownership diff", async ({
    makeInternalAgent,
  }) => {
    const originalOwner = user;
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      scope: "personal",
      systemPrompt: "Help with reports",
    });
    const response = await transfer(agent.id);
    expect(response.statusCode).toBe(200);
    const stored = await AgentModel.findById(agent.id, undefined, true);
    expect(stored).toMatchObject({
      authorId: recipient.id,
      scope: "personal",
      systemPrompt: "Help with reports",
    });
    expect(
      await AgentModel.findById(agent.id, originalOwner.id, false),
    ).toBeNull();
    expect(
      await AgentModel.findById(agent.id, recipient.id, false),
    ).not.toBeNull();
    expect((await transfer(agent.id, originalOwner.id)).statusCode).toBe(403);
    const rows = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: agent.id,
      action: "agent.updated",
      limit: 10,
      offset: 0,
    });
    expect(rows.data).toHaveLength(1);
    expect(rows.data[0].before).toMatchObject({ authorId: originalOwner.id });
    expect(rows.data[0].after).toMatchObject({ authorId: recipient.id });
    user = recipient;
    expect((await transfer(agent.id, originalOwner.id)).statusCode).toBe(200);
  });

  test("allows a resource admin to transfer another user's gateway", async ({
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const owner = user;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    const agent = await makeAgent({
      organizationId,
      authorId: owner.id,
      agentType: "mcp_gateway",
      scope: "personal",
    });
    expect((await transfer(agent.id)).statusCode).toBe(200);
    expect(await AgentModel.findById(agent.id, undefined, true)).toMatchObject({
      authorId: recipient.id,
      agentType: "mcp_gateway",
    });
  });

  test("rejects a non-owner even when the resource is visible", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId,
      authorId: recipient.id,
      scope: "org",
    });
    expect((await transfer(agent.id, user.id)).statusCode).toBe(403);
    expect(await AgentModel.findById(agent.id, undefined, true)).toMatchObject({
      authorId: recipient.id,
    });
  });

  test("rejects foreign resources and recipients, missing users, and the current owner", async ({
    makeOrganization,
    makeInternalAgent,
    makeUser,
    makeMember,
  }) => {
    const foreignOrg = await makeOrganization();
    const foreignUser = await makeUser();
    await makeMember(foreignUser.id, foreignOrg.id);
    const foreignAgent = await makeInternalAgent({
      organizationId: foreignOrg.id,
      authorId: user.id,
    });
    expect((await transfer(foreignAgent.id)).statusCode).toBe(404);
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
    });
    for (const ownerId of [foreignUser.id, "missing-user", user.id]) {
      expect((await transfer(agent.id, ownerId)).statusCode).toBe(400);
    }
    expect(await AgentModel.findById(agent.id, undefined, true)).toMatchObject({
      authorId: user.id,
    });
  });

  test("rejects managed gateways and LLM proxies", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    for (const fields of [
      { agentType: "mcp_gateway" as const, isPersonalGateway: true },
      { agentType: "llm_proxy" as const },
    ]) {
      const agent = await makeAgent({
        organizationId,
        authorId: user.id,
        ...fields,
      });
      expect((await transfer(agent.id)).statusCode).toBe(400);
    }
  });

  test("rejects a transfer that would lose access to a static team connection", async ({
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const team = await makeTeam(organizationId, user.id);
    await makeTeamMember(team.id, user.id);
    const connection = await makeMcpServer({
      name: "Reporting connection",
      scope: "team",
      teamId: team.id,
    });
    const tool = await makeTool({
      name: "reporting-tool",
      catalogId: connection.catalogId,
    });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      scope: "personal",
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });
    const response = await transfer(agent.id);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("pinned to a connection");
    expect(await AgentModel.findById(agent.id, undefined, true)).toMatchObject({
      authorId: user.id,
    });
  });
  test("hands the creator's grant to the new owner rather than checking their visibility", async ({
    makeInternalAgent,
  }) => {
    // Access is the object's grant, so there is no visibility the recipient
    // has to be able to manage: they simply receive what the creator held.
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      scope: "org",
    });
    expect((await transfer(agent.id)).statusCode).toBe(200);
    expect(await AgentModel.findById(agent.id, undefined, true)).toMatchObject({
      authorId: recipient.id,
    });
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "agent",
      scope: agent.id,
    });
    expect(policy?.grants).toEqual(
      expect.arrayContaining([
        {
          subject: { type: "user", id: recipient.id },
          actions: ["delete", "manage-permissions", "read", "update", "use"],
        },
      ]),
    );
    expect(policy?.grants).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: { type: "user", id: user.id } }),
      ]),
    );
  });

  test("refuses an owner whose grant on the agent has been revoked", async ({
    makeUser,
    makeMember,
    makeCustomRole,
    makeInternalAgent,
  }) => {
    // A role's update action is authority over the resource type, not over one
    // object, so it is the object's grant that decides. Creating the agent
    // hands its creator that grant; taking it away ends the authority, even
    // though the row still names them as author.
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read", "update"] },
    });
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: role.role });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      scope: "personal",
    });
    const key = {
      organizationId,
      resource: "agent" as const,
      scope: agent.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    expect((await transfer(agent.id)).statusCode).toBe(403);
  });

  test("does not hand over a personal model key the recipient cannot use", async ({
    makeInternalAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret();
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      scope: "personal",
      userId: user.id,
    });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      scope: "personal",
      llmApiKeyId: key.id,
    });
    const response = await transfer(agent.id);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("model API key");
    expect(await AgentModel.findById(agent.id, undefined, true)).toMatchObject({
      authorId: user.id,
    });
  });

  test("a stale ownership snapshot cannot overwrite a completed transfer", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      scope: "personal",
    });
    expect((await transfer(agent.id)).statusCode).toBe(200);
    expect(
      await AgentModel.transferOwnership({
        id: agent.id,
        organizationId,
        previousOwnerId: user.id,
        updatedAt: agent.updatedAt,
        ownerId: user.id,
      }),
    ).toBe(false);
    expect(await AgentModel.findById(agent.id, undefined, true)).toMatchObject({
      authorId: recipient.id,
    });
  });
});
