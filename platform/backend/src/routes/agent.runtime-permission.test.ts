import { buildCustomAgentRuntime } from "@archestra/shared";
import { vi } from "vitest";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import AgentModel from "@/models/agent";
import TeamModel from "@/models/team";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./agent";

vi.mock("@/observability");

const runtime = buildCustomAgentRuntime({ image: "example.test/worker:v1" });

describe("agent runtime configuration permission", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(() => {
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
  });

  test.for([
    false,
    true,
  ])("create and clone require runtime authority (%s)", async (allowed, {
    makeMember,
    makeCustomRole,
    makeAgent,
  }) => {
    const role = await makeCustomRole(ctx.organizationId, {
      permission: {
        agent: [
          "read",
          "create",
          ...(allowed ? ["configure-runtime" as const] : []),
        ],
      },
    });
    await makeMember(ctx.user.id, ctx.organizationId, { role: role.role });
    const plain = await ctx.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { agentType: "agent", name: "Plain agent" },
    });
    expect(plain.statusCode).toBe(200);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { agentType: "agent", name: "Runtime agent", runtime },
    });
    expect(created.statusCode, created.body).toBe(allowed ? 200 : 403);
    const source = await makeAgent({
      agentType: "agent",
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      runtime,
    });
    const cloned = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${source.id}/clone`,
      payload: {},
    });
    expect(cloned.statusCode, cloned.body).toBe(allowed ? 200 : 403);
  });

  test.for([
    false,
    true,
  ])("partial edits preserve runtime; runtime transitions require authority (%s)", async (allowed, {
    makeMember,
    makeCustomRole,
    makeAgent,
  }) => {
    const role = await makeCustomRole(ctx.organizationId, {
      permission: {
        agent: [
          "read",
          "create",
          ...(allowed ? ["configure-runtime" as const] : []),
        ],
      },
    });
    await makeMember(ctx.user.id, ctx.organizationId, { role: role.role });
    const agent = await makeAgent({
      agentType: "agent",
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      runtime,
    });
    const put = (payload: object) =>
      ctx.app.inject({
        method: "PUT",
        url: `/api/agents/${agent.id}`,
        payload,
      });
    expect((await put({ name: "Renamed" })).statusCode).toBe(200);
    expect((await AgentModel.findById(agent.id))?.runtime).toEqual(runtime);
    expect((await put({ runtime })).statusCode).toBe(200);
    expect(
      (await put({ runtime: { ...runtime, image: "example.test/worker:v2" } }))
        .statusCode,
    ).toBe(allowed ? 200 : 403);
    expect((await put({ runtime: null })).statusCode).toBe(allowed ? 200 : 403);
    expect((await AgentModel.findById(agent.id))?.runtime).toEqual(
      allowed ? null : runtime,
    );
    const plain = await makeAgent({
      agentType: "agent",
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
    });
    const enabled = await ctx.app.inject({
      method: "PUT",
      url: `/api/agents/${plain.id}`,
      payload: { runtime },
    });
    expect(enabled.statusCode).toBe(allowed ? 200 : 403);
  });

  test("team roles grant runtime configuration only inside their organization", async ({
    makeMember,
    makeCustomRole,
    makeTeam,
    makeTeamMember,
    makeOrganization,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const role = await makeCustomRole(ctx.organizationId, {
      permission: { agent: ["configure-runtime"] },
    });
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    await TeamModel.update(team.id, { roles: [role.role] });
    await makeTeamMember(team.id, ctx.user.id);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { agentType: "agent", name: "Team worker", runtime },
    });
    expect(created.statusCode, created.body).toBe(200);
    ctx.organizationId = (await makeOrganization()).id;
    await makeMember(ctx.user.id, ctx.organizationId);
    const outside = await ctx.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { agentType: "agent", name: "Outside worker", runtime },
    });
    expect(outside.statusCode, outside.body).toBe(403);
  });

  test.for([
    false,
    true,
  ])("service-account roles enforce the same runtime boundary (%s)", async (allowed, {
    makeCustomRole,
    makeServiceAccount,
  }) => {
    const role = await makeCustomRole(ctx.organizationId, {
      permission: {
        agent: [
          "read",
          "create",
          ...(allowed ? ["configure-runtime" as const] : []),
        ],
      },
    });
    const account = await makeServiceAccount(ctx.organizationId, {
      role: role.role,
    });
    ctx.user = { ...ctx.user, id: serviceAccountUserId(account.id) };
    const result = await ctx.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { agentType: "agent", name: "Automation runtime", runtime },
    });
    expect(result.statusCode, result.body).toBe(allowed ? 200 : 403);
  });
});
