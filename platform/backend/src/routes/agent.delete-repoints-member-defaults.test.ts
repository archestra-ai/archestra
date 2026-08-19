import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import { AgentModel, MemberModel, OrganizationModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * `members.default_agent_id` is a member's personal default: one of their own
 * personal chat agents (the seeded "My Assistant" to begin with). Deleting it
 * moves them onto their next personal agent, or — with none left — clears
 * the pointer so the organization default applies. Only when neither exists
 * is the delete refused, and the message names the setting that fixes it.
 *
 * Refusing whenever any member pointed at the agent (the previous rule) left
 * the seeded assistant undeletable forever, because nothing in the product
 * ever moved that pointer.
 */
describe("DELETE /api/agents/:id — members defaulting to the agent", () => {
  let app: FastifyInstanceWithZod;
  let admin: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: admin, organizationId });
    });
    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  async function seededAssistantId(): Promise<string> {
    await AgentModel.ensurePersonalChatAgent({
      userId: admin.id,
      organizationId,
    });
    const id = await MemberModel.getDefaultAgentId(admin.id, organizationId);
    if (!id) throw new Error("expected a seeded personal assistant");
    return id;
  }

  test("with an org default and no other personal agent, deletes and clears the member's default", async ({
    makeInternalAgent,
  }) => {
    const assistantId = await seededAssistantId();
    const orgDefault = await makeInternalAgent({
      organizationId,
      scope: "org",
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: orgDefault.id,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/agents/${assistantId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(await AgentModel.findById(assistantId)).toBeNull();
    expect(
      await MemberModel.getDefaultAgentId(admin.id, organizationId),
    ).toBeNull();
  });

  test("the deleted assistant is not re-seeded afterwards", async ({
    makeInternalAgent,
  }) => {
    const assistantId = await seededAssistantId();
    const orgDefault = await makeInternalAgent({
      organizationId,
      scope: "org",
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: orgDefault.id,
    });
    await app.inject({ method: "DELETE", url: `/api/agents/${assistantId}` });

    // What login, app chats and backend start all call.
    await AgentModel.ensurePersonalChatAgent({
      userId: admin.id,
      organizationId,
    });

    expect(
      await MemberModel.getDefaultAgentId(admin.id, organizationId),
    ).toBeNull();
    expect(await AgentModel.findById(assistantId)).toBeNull();
  });

  test("moves the member onto their next personal agent, even with an org default", async ({
    makeInternalAgent,
  }) => {
    const assistantId = await seededAssistantId();
    const own = await makeInternalAgent({
      organizationId,
      scope: "personal",
      authorId: admin.id,
    });
    const orgDefault = await makeInternalAgent({
      organizationId,
      scope: "org",
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: orgDefault.id,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/agents/${assistantId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(await MemberModel.getDefaultAgentId(admin.id, organizationId)).toBe(
      own.id,
    );
  });

  test("refuses when the member has no other personal agent and there is no org default", async () => {
    const assistantId = await seededAssistantId();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/agents/${assistantId}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe(
      "Cannot delete a default agent. Set another agent as default first.",
    );
    expect(await AgentModel.findById(assistantId)).not.toBeNull();
    expect(await MemberModel.getDefaultAgentId(admin.id, organizationId)).toBe(
      assistantId,
    );
  });

  test("ignores an organization default that is no longer a live agent", async ({
    makeInternalAgent,
  }) => {
    const assistantId = await seededAssistantId();
    const orgDefault = await makeInternalAgent({
      organizationId,
      scope: "org",
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: orgDefault.id,
    });
    await AgentModel.delete(orgDefault.id);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/agents/${assistantId}`,
    });

    expect(response.statusCode).toBe(403);
    expect(await MemberModel.getDefaultAgentId(admin.id, organizationId)).toBe(
      assistantId,
    );
  });

  test("leaves members defaulting to a different agent alone", async ({
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const other = await makeUser();
    await makeMember(other.id, organizationId);
    await AgentModel.ensurePersonalChatAgent({
      userId: other.id,
      organizationId,
    });
    const othersAssistantId = await MemberModel.getDefaultAgentId(
      other.id,
      organizationId,
    );

    const doomed = await makeInternalAgent({ organizationId, scope: "org" });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/agents/${doomed.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(await MemberModel.getDefaultAgentId(other.id, organizationId)).toBe(
      othersAssistantId,
    );
  });
});
