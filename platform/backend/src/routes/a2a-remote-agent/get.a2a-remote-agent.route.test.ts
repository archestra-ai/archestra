import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { createA2aRemoteAgent } from "@/services/a2a-outbound-registry";
import { describe, expect, test, useRouteTestApp } from "@/test";
import a2aRemoteAgentRoutes from "./a2a-remote-agent.routes";
import { makeAgentCard } from "./a2a-remote-agent.test-helpers";

describe("outbound A2A visibility reads", () => {
  const ctx = useRouteTestApp(a2aRemoteAgentRoutes);

  test("list, filters, and direct reads enforce owner/team/org/user visibility", async ({
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const owner = ctx.user;
    const viewer = await makeUser({ name: "A2A Viewer" });
    await makeMember(owner.id, ctx.organizationId, {
      role: MEMBER_ROLE_NAME,
    });
    await makeMember(viewer.id, ctx.organizationId, {
      role: MEMBER_ROLE_NAME,
    });
    const team = await makeTeam(ctx.organizationId, owner.id, {
      name: "A2A Shared Team",
    });
    await makeTeamMember(team.id, viewer.id);

    const personal = await createRemote(ctx, {
      name: "Owner only",
      scope: "personal",
    });
    const sharedUser = await createRemote(ctx, {
      name: "Shared directly",
      scope: "personal",
      users: [viewer.id],
    });
    const sharedTeam = await createRemote(ctx, {
      name: "Shared with team",
      scope: "team",
      teams: [team.id],
    });
    const organization = await createRemote(ctx, {
      name: "Shared with organization",
      scope: "org",
    });
    const credentialBackedResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        name: "Credential-backed target",
        source: { type: "inline_card", agentCard: makeAgentCard("api-key") },
        auth: {
          type: "api_key",
          headerName: "X-API-Key",
          credential: "list-secret",
        },
        scope: "org",
      },
    });
    expect(credentialBackedResponse.statusCode).toBe(200);
    const credentialBacked = credentialBackedResponse.json();
    const foreignOrganization = await makeOrganization();
    await createA2aRemoteAgent({
      organizationId: foreignOrganization.id,
      input: {
        name: "Foreign target",
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
      },
    });

    ctx.user = viewer;
    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/a2a/remote-agents",
    });
    expect(list.statusCode).toBe(200);
    const listed = list.json();
    expect(new Set(listed.map((item: { id: string }) => item.id))).toEqual(
      new Set([
        sharedUser.id,
        sharedTeam.id,
        organization.id,
        credentialBacked.id,
      ]),
    );
    expect(
      listed.find((item: { id: string }) => item.id === credentialBacked.id),
    ).toMatchObject({
      connection: {
        authType: "api_key",
        authConfig: { headerName: "X-API-Key" },
        hasCredential: true,
      },
    });
    expect(JSON.stringify(listed)).not.toContain("list-secret");
    expect(JSON.stringify(listed)).not.toContain("Foreign target");
    expect(
      listed.find((item: { id: string }) => item.id === credentialBacked.id)
        .connection.secretId,
    ).toBeUndefined();

    const teamFilter = await ctx.app.inject({
      method: "GET",
      url: `/api/a2a/remote-agents?scope=team&teamId=${team.id}`,
    });
    expect(teamFilter.statusCode).toBe(200);
    expect(teamFilter.json().map((item: { id: string }) => item.id)).toEqual([
      sharedTeam.id,
    ]);

    const authorFilter = await ctx.app.inject({
      method: "GET",
      url: `/api/a2a/remote-agents?authorId=${owner.id}`,
    });
    expect(authorFilter.statusCode).toBe(200);
    expect(authorFilter.json()).toHaveLength(4);

    const visibleDetail = await ctx.app.inject({
      method: "GET",
      url: `/api/a2a/remote-agents/${sharedUser.id}`,
    });
    expect(visibleDetail.statusCode).toBe(200);
    expect(visibleDetail.json()).toMatchObject({
      id: sharedUser.id,
      authorId: owner.id,
      authorName: owner.name,
      users: [{ id: viewer.id, name: viewer.name, email: viewer.email }],
    });

    const hiddenDetail = await ctx.app.inject({
      method: "GET",
      url: `/api/a2a/remote-agents/${personal.id}`,
    });
    expect(hiddenDetail.statusCode).toBe(404);

    ctx.user = owner;
    const ownerDetail = await ctx.app.inject({
      method: "GET",
      url: `/api/a2a/remote-agents/${personal.id}`,
    });
    expect(ownerDetail.statusCode).toBe(200);
  });

  test("an agent-settings manager can inspect all scopes", async ({
    makeMember,
    makeUser,
  }) => {
    const owner = ctx.user;
    await makeMember(owner.id, ctx.organizationId, {
      role: MEMBER_ROLE_NAME,
    });
    const hidden = await createRemote(ctx, {
      name: "Managed personal target",
      scope: "personal",
    });

    const manager = await makeUser({ name: "A2A Manager" });
    await makeMember(manager.id, ctx.organizationId, { role: ADMIN_ROLE_NAME });
    ctx.user = manager;

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/a2a/remote-agents",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((item: { id: string }) => item.id)).toContain(
      hidden.id,
    );

    const accessibleList = await ctx.app.inject({
      method: "GET",
      url: "/api/a2a/remote-agents?accessibleOnly=true",
    });
    expect(accessibleList.statusCode).toBe(200);
    expect(
      accessibleList.json().map((item: { id: string }) => item.id),
    ).not.toContain(hidden.id);

    const managementList = await ctx.app.inject({
      method: "GET",
      url: "/api/a2a/remote-agents?accessibleOnly=false",
    });
    expect(managementList.statusCode).toBe(200);
    expect(
      managementList.json().map((item: { id: string }) => item.id),
    ).toContain(hidden.id);

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/api/a2a/remote-agents/${hidden.id}`,
    });
    expect(detail.statusCode).toBe(200);
  });
});

async function createRemote(
  ctx: ReturnType<typeof useRouteTestApp>,
  visibility: {
    name: string;
    scope: "personal" | "team" | "org";
    teams?: string[];
    users?: string[];
  },
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/a2a/remote-agents",
    payload: {
      ...visibility,
      source: { type: "inline_card", agentCard: makeAgentCard("none") },
      auth: { type: "none" },
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}
