import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import { AgentModel, MemberModel, OrganizationModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * A member's personal default agent: at most one of their own personal chat
 * agents, preselected for their new chats ahead of the organization default.
 *
 * PUT /api/members/default-agent is the only thing that writes it. Seeding the
 * assistant, creating, cloning, importing or restoring a personal agent all
 * leave it alone — an agent nobody chose must not shadow the organization
 * default, which is what made an admin's Default Agent setting reach nobody.
 */
describe("/api/members/default-agent", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const put = (defaultAgentId: string | null) =>
    app.inject({
      method: "PUT",
      url: "/api/members/default-agent",
      payload: { defaultAgentId },
    });

  const current = () =>
    app
      .inject({ method: "GET", url: "/api/members/default-agent" })
      .then((r) => r.json().defaultAgentId as string | null);

  test("sets one of the caller's own personal agents as their default", async ({
    makeInternalAgent,
  }) => {
    await AgentModel.ensurePersonalChatAgent({
      userId: user.id,
      organizationId,
    });
    const second = await makeInternalAgent({
      organizationId,
      scope: "personal",
      authorId: user.id,
    });
    expect(await current()).toBeNull();

    const response = await put(second.id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ defaultAgentId: second.id });
    expect(await current()).toBe(second.id);
  });

  test("clearing it leaves the member on the organization default", async ({
    makeInternalAgent,
  }) => {
    await AgentModel.ensurePersonalChatAgent({
      userId: user.id,
      organizationId,
    });
    const orgDefault = await makeInternalAgent({
      organizationId,
      scope: "org",
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: orgDefault.id,
    });

    const response = await put(null);

    expect(response.statusCode).toBe(200);
    expect(await current()).toBeNull();
    // Their assistant is still theirs; nothing was deleted or re-seeded.
    await AgentModel.ensurePersonalChatAgent({
      userId: user.id,
      organizationId,
    });
    expect(await current()).toBeNull();
  });

  test("accepts any chat agent the caller can see, whatever its scope", async ({
    makeInternalAgent,
  }) => {
    // Pinning a default is about whose chats it starts, not about who owns
    // the agent: an organization-wide agent is as pinnable as one's own.
    const orgAgent = await makeInternalAgent({ organizationId, scope: "org" });

    const response = await put(orgAgent.id);

    expect(response.statusCode).toBe(200);
    expect(await current()).toBe(orgAgent.id);
  });

  test("rejects what the caller cannot chat with: non-chat agents and built-ins", async ({
    makeAgent,
    makeInternalAgent,
    makeOrganization,
  }) => {
    const proxy = await makeAgent({
      organizationId,
      agentType: "llm_proxy",
      scope: "personal",
      authorId: user.id,
    });
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
      scope: "personal",
      authorId: user.id,
    });
    const foreign = await makeInternalAgent({
      organizationId: (await makeOrganization()).id,
      scope: "org",
    });
    const before = await current();

    for (const id of [proxy.id, gateway.id, foreign.id]) {
      const response = await put(id);
      expect(response.statusCode).toBe(404);
    }
    expect(await current()).toBe(before);
  });

  test("rejects an agent this caller cannot see", async ({
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const stranger = await makeUser();
    await makeMember(stranger.id, organizationId);
    const strangersAgent = await makeInternalAgent({
      organizationId,
      scope: "personal",
      authorId: stranger.id,
    });

    // A plain member, so no agent-admin bypass: someone else's personal agent
    // is not in their picker, and the 404 says nothing more than "not found".
    const plain = await makeUser();
    await makeMember(plain.id, organizationId);
    user = plain;

    const response = await put(strangersAgent.id);

    expect(response.statusCode).toBe(404);
    expect(await current()).toBeNull();
  });

  test("no creation path claims the default: not seeding, not a first personal agent", async ({
    makeInternalAgent,
  }) => {
    expect(await current()).toBeNull();

    await AgentModel.ensurePersonalChatAgent({
      userId: user.id,
      organizationId,
    });
    expect(await current()).toBeNull();

    await makeInternalAgent({
      organizationId,
      scope: "personal",
      authorId: user.id,
    });
    expect(await current()).toBeNull();
  });

  test("restoring an agent does not re-adopt it as the default", async ({
    makeInternalAgent,
  }) => {
    const only = await makeInternalAgent({
      organizationId,
      scope: "personal",
      authorId: user.id,
    });
    await put(only.id);
    const orgDefault = await makeInternalAgent({
      organizationId,
      scope: "org",
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: orgDefault.id,
    });
    await app.inject({ method: "DELETE", url: `/api/agents/${only.id}` });
    expect(await current()).toBeNull();

    const restore = await app.inject({
      method: "POST",
      url: `/api/agents/${only.id}/restore`,
    });

    // The choice was cleared with the delete and is the member's to make
    // again — a restore must not silently reinstate it.
    expect(restore.statusCode).toBe(200);
    expect(await current()).toBeNull();
  });

  test("seeding skips a member who deleted their seeded assistant", async ({
    makeInternalAgent,
  }) => {
    const assistantId = await AgentModel.ensurePersonalChatAgent({
      userId: user.id,
      organizationId,
    });
    const orgDefault = await makeInternalAgent({
      organizationId,
      scope: "org",
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: orgDefault.id,
    });
    await app.inject({ method: "DELETE", url: `/api/agents/${assistantId}` });

    await AgentModel.ensurePersonalChatAgent({
      userId: user.id,
      organizationId,
    });

    expect(await current()).toBeNull();
    expect(
      await MemberModel.getDefaultAgentId(user.id, organizationId),
    ).toBeNull();
  });
});
