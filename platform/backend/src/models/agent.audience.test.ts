// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

/**
 * The personal / team / organization label an agent list filters and sorts by
 * comes from the agent's own grants. The retired scope column is seeded here
 * to say the opposite, so a test passes only if nothing reads it.
 */
describe("agent audience from grants", () => {
  test("the scope and team filters follow the agent's grants", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const team = await makeTeam(org.id, admin.id);
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      authorId: admin.id,
    });
    await replaceGrants(org.id, agent.id, [
      { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
    ]);

    const list = async (filters: {
      scope?: "personal" | "team" | "org";
      teamIds?: string[];
    }) =>
      (
        await AgentModel.findAllPaginated(
          { limit: 50, offset: 0 },
          undefined,
          { organizationId: org.id, agentType: "agent", ...filters },
          admin.id,
          true,
        )
      ).data.map((item) => item.id);

    expect(await list({ scope: "team" })).toContain(agent.id);
    expect(await list({ scope: "org" })).not.toContain(agent.id);
    expect(await list({ teamIds: [team.id] })).toContain(agent.id);

    await replaceGrants(org.id, agent.id, [
      { subject: { type: "role", id: "member" }, actions: ["read", "use"] },
    ]);
    expect(await list({ scope: "org" })).toContain(agent.id);
    expect(await list({ teamIds: [team.id] })).not.toContain(agent.id);
  });

  test("the chat agent pickers leave out agents that reach only their author", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const other = await makeUser();
    await makeMember(author.id, org.id);
    await makeMember(other.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      authorId: author.id,
    });
    await replaceGrants(org.id, agent.id, []);

    const shared = async () =>
      (await AgentModel.findAllInternalAgents()).map((item) => item.id);
    const forUser = async (userId: string) =>
      (await AgentModel.findAllInternalAgentsIncludingPersonal(userId)).map(
        (item) => item.id,
      );
    expect(await shared()).not.toContain(agent.id);
    expect(await forUser(author.id)).toContain(agent.id);
    expect(await forUser(other.id)).not.toContain(agent.id);

    await replaceGrants(org.id, agent.id, [
      { subject: { type: "role", id: "member" }, actions: ["read", "use"] },
    ]);
    expect(await shared()).toContain(agent.id);
    expect(await forUser(other.id)).toContain(agent.id);
  });
});

async function replaceGrants(
  organizationId: string,
  agentId: string,
  grants: Parameters<typeof ResourcePermissionPolicyModel.replace>[0]["grants"],
) {
  const key = { organizationId, resource: "agent" as const, scope: agentId };
  const policy = await ResourcePermissionPolicyModel.find(key);
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy?.revision ?? 0,
    grants,
  });
}
