import AgentModel from "@/models/agent";
import OrganizationModel from "@/models/organization";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./organization";

describe("personal tool mode defaults", () => {
  const ctx = useRouteTestApp(routes);
  const save = (accessAllTools: boolean) =>
    ctx.app.inject({
      method: "PATCH",
      url: "/api/organization/mcp-settings",
      payload: { defaultPersonalAgentAccessAllTools: accessAllTools },
    });

  test("defaults to All, affects only new personal assistants and gateways, and preserves explicit choices", async ({
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const provision = async (userId: string) => {
      const params = { userId, organizationId: ctx.organizationId };
      const id = await AgentModel.ensurePersonalChatAgent(params);
      if (!id)
        throw new Error("Expected a newly provisioned personal assistant");
      const gateway = await AgentModel.ensurePersonalMcpGateway({
        ...params,
        includeTools: false,
      });
      return {
        agent: await AgentModel.findById(id),
        gateway: await AgentModel.findById(gateway.id),
      };
    };
    expect(
      (await OrganizationModel.getById(ctx.organizationId))
        ?.defaultPersonalAgentAccessAllTools,
    ).toBe(true);
    const old = await provision(ctx.user.id);
    expect(old.agent?.accessAllTools).toBe(true);
    expect(old.gateway?.accessAllTools).toBe(true);

    const changed = await save(false);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().defaultPersonalAgentAccessAllTools).toBe(false);
    expect(
      (
        await OrganizationModel.findByIdForAudit(
          ctx.organizationId,
          ctx.organizationId,
        )
      )?.defaultPersonalAgentAccessAllTools,
    ).toBe(false);
    const read = await ctx.app.inject({
      method: "GET",
      url: "/api/organization",
    });
    expect(read.json().defaultPersonalAgentAccessAllTools).toBe(false);
    expect(await provision(ctx.user.id)).toEqual(old);

    const nextUser = await makeUser();
    await makeMember(nextUser.id, ctx.organizationId);
    const custom = await provision(nextUser.id);
    expect(custom.agent?.accessAllTools).toBe(false);
    expect(custom.gateway?.accessAllTools).toBe(false);
    const explicit = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      authorId: nextUser.id,
      accessAllTools: true,
    });
    expect(explicit.accessAllTools).toBe(true);

    expect((await save(true)).statusCode).toBe(200);
    expect(await provision(nextUser.id)).toEqual(custom);
    const thirdUser = await makeUser();
    await makeMember(thirdUser.id, ctx.organizationId);
    const all = await provision(thirdUser.id);
    expect(all.agent?.accessAllTools).toBe(true);
    expect(all.gateway?.accessAllTools).toBe(true);
    expect((await AgentModel.findById(explicit.id))?.accessAllTools).toBe(true);
  });

  test("startup provisioning honors each organization's default without rewriting existing gateways", async ({
    makeUser,
    makeMember,
    makeOrganization,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const existing = await AgentModel.ensurePersonalMcpGateway({
      userId: ctx.user.id,
      organizationId: ctx.organizationId,
      includeTools: false,
    });
    const before = await AgentModel.findById(existing.id);
    expect((await save(false)).statusCode).toBe(200);
    const user = await makeUser();
    await makeMember(user.id, ctx.organizationId);
    const otherOrg = await makeOrganization();
    const otherUser = await makeUser();
    await makeMember(otherUser.id, otherOrg.id);
    expect(await AgentModel.bulkBackfillPersonalMcpGateways()).toBe(2);
    expect(
      (
        await AgentModel.getPersonalMcpGateway(user.id, ctx.organizationId, {
          includeTools: false,
        })
      )?.accessAllTools,
    ).toBe(false);
    expect(
      (
        await AgentModel.getPersonalMcpGateway(otherUser.id, otherOrg.id, {
          includeTools: false,
        })
      )?.accessAllTools,
    ).toBe(true);
    expect(await AgentModel.findById(existing.id)).toEqual(before);
    expect(await AgentModel.bulkBackfillPersonalMcpGateways()).toBe(0);
  });
});
