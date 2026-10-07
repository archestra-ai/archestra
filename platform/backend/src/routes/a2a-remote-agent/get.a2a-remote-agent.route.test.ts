import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
  type ResourcePermissionGrant,
} from "@archestra/shared";
import { A2aOutboundRunModel } from "@/models";
import AgentToolModel from "@/models/agent-tool";
import { createA2aRemoteAgent } from "@/services/a2a-outbound-registry";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import a2aRemoteAgentRoutes from "./a2a-remote-agent.routes";
import { makeAgentCard } from "./a2a-remote-agent.test-helpers";

describe("outbound A2A visibility reads", () => {
  const ctx = useRouteTestApp(a2aRemoteAgentRoutes);

  test("list, filters, and direct reads follow each agent's permission grants", async ({
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

    const personal = await createRemote(ctx, { name: "Owner only" });
    const sharedUser = await createRemote(ctx, {
      name: "Shared directly",
      initialGrants: [grant("user", viewer.id)],
    });
    const sharedTeam = await createRemote(ctx, {
      name: "Shared with team",
      initialGrants: [grant("team", team.id)],
    });
    const organization = await createRemote(ctx, {
      name: "Shared with organization",
      initialGrants: [grant("organization", "*")],
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
        initialGrants: [grant("organization", "*")],
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
    });
    expect(visibleDetail.json()).not.toHaveProperty("users");
    expect(visibleDetail.json()).not.toHaveProperty("scope");

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

  test("an administrator reaches every external agent through the organization-wide grant", async ({
    makeMember,
    makeUser,
  }) => {
    const owner = ctx.user;
    await makeMember(owner.id, ctx.organizationId, {
      role: MEMBER_ROLE_NAME,
    });
    const hidden = await createRemote(ctx, { name: "Managed personal target" });

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

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/api/a2a/remote-agents/${hidden.id}`,
    });
    expect(detail.statusCode).toBe(200);
  });

  test("list and detail return the exact number of local agent assignments", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const assigned = await createRemote(ctx, { name: "Assigned target" });
    const unassigned = await createRemote(ctx, { name: "Unassigned target" });
    const firstAgent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
    });
    const secondAgent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
    });
    await AgentToolModel.createIfNotExists(firstAgent.id, assigned.toolId);
    await AgentToolModel.createIfNotExists(secondAgent.id, assigned.toolId);
    await A2aOutboundRunModel.create({
      organizationId: ctx.organizationId,
      parentAgentId: firstAgent.id,
      remoteAgentId: assigned.id,
      connectionId: assigned.connection.id,
      toolId: assigned.toolId,
      messageId: "latest-use-message",
      state: "completed",
      targetNameSnapshot: assigned.name,
      interfaceSnapshot: assigned.connection.selectedInterface,
      startedAt: new Date("2026-09-09T12:00:00.000Z"),
      completedAt: new Date("2026-09-09T12:01:00.000Z"),
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/a2a/remote-agents",
    });
    expect(list.statusCode).toBe(200);
    expect(
      list
        .json()
        .map(
          (item: {
            id: string;
            assignmentCount: number;
            lastUsedAt: string | null;
          }) => ({
            id: item.id,
            assignmentCount: item.assignmentCount,
            lastUsedAt: item.lastUsedAt,
          }),
        ),
    ).toEqual(
      expect.arrayContaining([
        {
          id: assigned.id,
          assignmentCount: 2,
          lastUsedAt: "2026-09-09T12:00:00.000Z",
        },
        { id: unassigned.id, assignmentCount: 0, lastUsedAt: null },
      ]),
    );

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/api/a2a/remote-agents/${assigned.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      assignmentCount: 2,
      lastUsedAt: "2026-09-09T12:00:00.000Z",
    });
  });
});

async function createRemote(
  ctx: ReturnType<typeof useRouteTestApp>,
  visibility: { name: string; initialGrants?: ResourcePermissionGrant[] },
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

function grant(
  type: "user" | "team" | "organization",
  id: string,
): ResourcePermissionGrant {
  return {
    subject: { type, id } as ResourcePermissionGrant["subject"],
    actions: ["read", "use"],
  };
}
