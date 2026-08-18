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
 * The seeded "My Assistant" holds it to begin with; the member moves it with
 * PUT /api/members/default-agent, and their first personal agent adopts it
 * automatically whenever they have none.
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
    expect(await current()).not.toBe(second.id);

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

  test("rejects an org-scoped agent, someone else's personal agent, and non-chat agents", async ({
    makeInternalAgent,
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const orgAgent = await makeInternalAgent({ organizationId, scope: "org" });
    const stranger = await makeUser();
    await makeMember(stranger.id, organizationId);
    const strangersAgent = await makeInternalAgent({
      organizationId,
      scope: "personal",
      authorId: stranger.id,
    });
    const proxy = await makeAgent({
      organizationId,
      agentType: "llm_proxy",
      scope: "personal",
      authorId: user.id,
    });
    const before = await current();

    for (const id of [orgAgent.id, strangersAgent.id, proxy.id]) {
      const response = await put(id);
      expect(response.statusCode).toBe(404);
    }
    expect(await current()).toBe(before);
  });

  test("a member's first personal agent becomes their default automatically, later ones do not", async ({
    makeInternalAgent,
  }) => {
    // Never seeded: this member starts with no personal agent at all.
    expect(await current()).toBeNull();

    const first = await makeInternalAgent({
      organizationId,
      scope: "personal",
      authorId: user.id,
    });
    expect(await current()).toBe(first.id);

    await makeInternalAgent({
      organizationId,
      scope: "personal",
      authorId: user.id,
    });
    expect(await current()).toBe(first.id);
  });

  test("restoring a member's only personal agent re-adopts it as their default", async ({
    makeInternalAgent,
  }) => {
    const only = await makeInternalAgent({
      organizationId,
      scope: "personal",
      authorId: user.id,
    });
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

    expect(restore.statusCode).toBe(200);
    expect(await current()).toBe(only.id);
  });

  test("seeding skips a member who deleted their seeded assistant", async ({
    makeInternalAgent,
  }) => {
    await AgentModel.ensurePersonalChatAgent({
      userId: user.id,
      organizationId,
    });
    const assistantId = await current();
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
