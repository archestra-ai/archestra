import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import { AgentModel, MemberModel, OrganizationModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * `members.default_agent_id` records one thing: the personal chat agent a
 * member deliberately picked as their default. Deleting that agent clears the
 * choice — the same treatment projects get for a pinned agent — and the member
 * falls back to the organization default, then to their own personal agent.
 *
 * The delete is never refused over it. Refusing (the rule before this) was a
 * dead end: it fired on a pointer the member had never set, and the "set
 * another agent as default first" advice named a screen that could not satisfy
 * it. Nothing has to be repointed either, because the fallback chain always
 * resolves.
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

  /** The seeded "My Assistant" — created for the member, never chosen by them. */
  async function seededAssistantId(): Promise<string> {
    const id = await AgentModel.ensurePersonalChatAgent({
      userId: admin.id,
      organizationId,
    });
    if (!id) throw new Error("expected a seeded personal assistant");
    return id;
  }

  test("seeding does not make the assistant the member's default", async () => {
    await seededAssistantId();

    expect(
      await MemberModel.getDefaultAgentId(admin.id, organizationId),
    ).toBeNull();
  });

  test("clears the choice of members who had set the agent as their default", async () => {
    const assistantId = await seededAssistantId();
    await MemberModel.setDefaultAgent(admin.id, organizationId, assistantId);

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

  test("deletes without refusing even with no org default and no other personal agent", async () => {
    const assistantId = await seededAssistantId();
    await MemberModel.setDefaultAgent(admin.id, organizationId, assistantId);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/agents/${assistantId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(await AgentModel.findById(assistantId)).toBeNull();
  });

  test("does not repoint the member onto another personal agent they never chose", async ({
    makeInternalAgent,
  }) => {
    const assistantId = await seededAssistantId();
    await MemberModel.setDefaultAgent(admin.id, organizationId, assistantId);
    await makeInternalAgent({
      organizationId,
      scope: "personal",
      authorId: admin.id,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/agents/${assistantId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(
      await MemberModel.getDefaultAgentId(admin.id, organizationId),
    ).toBeNull();
  });

  test("restoring the agent does not silently restore the choice", async () => {
    const assistantId = await seededAssistantId();
    await MemberModel.setDefaultAgent(admin.id, organizationId, assistantId);
    await app.inject({ method: "DELETE", url: `/api/agents/${assistantId}` });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${assistantId}/restore`,
    });

    expect(response.statusCode).toBe(200);
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
    const reseeded = await AgentModel.ensurePersonalChatAgent({
      userId: admin.id,
      organizationId,
    });

    expect(reseeded).toBeNull();
    expect(await AgentModel.findById(assistantId)).toBeNull();
  });

  test("leaves members defaulting to a different agent alone", async ({
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const other = await makeUser();
    await makeMember(other.id, organizationId);
    const othersAssistantId = await AgentModel.ensurePersonalChatAgent({
      userId: other.id,
      organizationId,
    });
    if (!othersAssistantId) throw new Error("expected a seeded assistant");
    await MemberModel.setDefaultAgent(
      other.id,
      organizationId,
      othersAssistantId,
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
