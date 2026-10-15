// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import StatisticsModel from "./statistics";

describe("statistics team grant attribution", () => {
  test("counts object-local team read grants once and honors billing teams and organization boundaries", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const owner = await makeUser();
    const alpha = await makeTeam(org.id, owner.id, { name: "Alpha" });
    const beta = await makeTeam(org.id, owner.id, { name: "Beta" });
    const foreignTeam = await makeTeam(otherOrg.id, owner.id);
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      access: "personal",
    });
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      access: { teams: [beta.id] },
    });
    const deleted = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      access: { teams: [alpha.id] },
    });
    const privateAgent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      access: "personal",
    });
    const foreignAgent = await makeAgent({
      organizationId: otherOrg.id,
      agentType: "agent",
      access: { teams: [foreignTeam.id] },
    });
    const localKey = {
      organizationId: org.id,
      resource: "agent" as const,
      scope: agent.id,
    };
    const current = await ResourcePermissionPolicyModel.find(localKey);
    await ResourcePermissionPolicyModel.replace({
      ...localKey,
      revision: current?.revision ?? 0,
      grants: [
        { subject: { type: "team", id: alpha.id }, actions: ["read"] },
        { subject: { type: "team", id: alpha.id }, actions: ["read"] },
        { subject: { type: "user", id: beta.id }, actions: ["read"] },
        { subject: { type: "role", id: beta.id }, actions: ["read"] },
        { subject: { type: "team", id: foreignTeam.id }, actions: ["read"] },
      ],
    });
    for (const key of [
      {
        organizationId: org.id,
        resource: "agent" as const,
        scope: "*" as const,
      },
      {
        organizationId: otherOrg.id,
        resource: "agent" as const,
        scope: agent.id,
      },
      {
        organizationId: org.id,
        resource: "mcpGateway" as const,
        scope: agent.id,
      },
    ]) {
      const existing = await ResourcePermissionPolicyModel.find(key);
      await ResourcePermissionPolicyModel.replace({
        ...key,
        revision: existing?.revision ?? 0,
        grants: [{ subject: { type: "team", id: beta.id }, actions: ["read"] }],
      });
    }
    await makeInteraction(agent.id, { cost: "2", inputTokens: 10 });
    await makeInteraction(agent.id, {
      cost: "3",
      inputTokens: 20,
      billingTeamId: beta.id,
    });
    await makeInteraction(gateway.id, { cost: "5", inputTokens: 30 });
    await makeInteraction(privateAgent.id, { cost: "11" });
    await makeInteraction(deleted.id, { cost: "13" });
    await makeInteraction(foreignAgent.id, { cost: "17" });
    await AgentModel.delete(deleted.id);

    const teams = await StatisticsModel.getTeamStatistics({
      organizationId: org.id,
      timeframe: "24h",
    });
    expect(
      teams
        .map((row) => ({
          name: row.teamName,
          requests: row.requests,
          cost: row.cost,
          agents: row.agents,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: "Alpha", requests: 1, cost: 2, agents: 1 },
      { name: "Beta", requests: 2, cost: 8, agents: 1 },
    ]);
    const agents = await StatisticsModel.getAgentStatistics({
      organizationId: org.id,
      timeframe: "24h",
    });
    // Agent statistics retain the pre-existing per-recipient attribution,
    // including a grant whose team belongs to a different organization.
    expect(agents.find((row) => row.agentId === agent.id)).toMatchObject({
      requests: 4,
      cost: 10,
    });
    expect(agents.find((row) => row.agentId === privateAgent.id)).toMatchObject(
      { requests: 1, cost: 11, teamName: "No Team" },
    );
    expect(
      agents.some(
        (row) => row.agentId === deleted.id || row.agentId === foreignAgent.id,
      ),
    ).toBe(false);
  });

  test("missing team recipients do not multiply an unassigned agent's usage", async ({
    makeOrganization,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      access: "personal",
    });
    const key = {
      organizationId: org.id,
      resource: "agent" as const,
      scope: agent.id,
    };
    const current = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: current?.revision ?? 0,
      grants: [
        { subject: { type: "team", id: "missing-alpha" }, actions: ["read"] },
        { subject: { type: "team", id: "missing-beta" }, actions: ["read"] },
      ],
    });
    await makeInteraction(agent.id, { cost: "7" });
    expect(
      await StatisticsModel.getTeamStatistics({
        organizationId: org.id,
        timeframe: "24h",
      }),
    ).toEqual([]);
    const agents = await StatisticsModel.getAgentStatistics({
      organizationId: org.id,
      timeframe: "24h",
    });
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      agentId: agent.id,
      requests: 1,
      cost: 7,
      teamName: "No Team",
    });
  });
});
