// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import config from "@/config";
import AgentTeamModel from "@/models/agent-team";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { afterEach, describe, expect, test } from "@/test";
import { ResourcePermissions } from "./resource-permissions";

/**
 * The rollout switch, proved from both sides.
 *
 * The upgrade writes grant rows whether or not a deployment reads them, so
 * "off" has to mean more than a hidden screen: authorization must keep
 * answering from the retired visibility columns, and a revocation recorded in
 * the grant table must not take effect. "On" must then honour that same
 * revocation. Both directions run against real rows through the same paths the
 * product uses.
 */
describe("scoped resource permission rollout", () => {
  afterEach(() => {
    config.resourcePermissions.enabled = true;
  });

  test("creating with explicit grants while the switch is off is refused, not dropped", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const creator = await makeUser();
    const recipient = await makeUser();
    await makeMember(creator.id, org.id, { role: "admin" });
    await makeMember(recipient.id, org.id);
    config.resourcePermissions.enabled = false;
    await expect(
      ResourcePermissions.validateInitialGrants({
        organizationId: org.id,
        userId: creator.id,
        resource: "agent",
        grants: [
          {
            subject: { type: "user", id: recipient.id },
            actions: ["read", "use"],
          },
        ],
        target: {
          id: crypto.randomUUID(),
          name: "Refused at the door",
          authorId: creator.id,
          scope: "personal",
          teams: [],
          users: [],
        },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("grants stay inert while the switch is off and take effect once it is on", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const reader = await makeUser();
    await makeMember(reader.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      scope: "org",
    });
    const key = {
      organizationId: org.id,
      resource: "agent" as const,
      scope: agent.id,
    };
    const access = {
      agentId: agent.id,
      userId: reader.id,
      isAgentAdmin: false,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    expect(policy?.legacySharingMigrated).toBe(true);
    expect(await AgentTeamModel.userHasAgentAccess(access)).toBe(true);

    // Revoke every grant. The agent is still organization-visible, so the
    // retired columns and the grant table now disagree on purpose.
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    expect(await AgentTeamModel.userHasAgentAccess(access)).toBe(false);
    expect(
      await ResourcePermissions.allows({
        organizationId: org.id,
        userId: reader.id,
        resource: "agent",
        scope: agent.id,
        action: "read",
      }),
    ).toBe(false);

    config.resourcePermissions.enabled = false;
    // Off: the revocation is ignored and organization visibility answers
    // again, both for the single check and for the list filter.
    expect(await AgentTeamModel.userHasAgentAccess(access)).toBe(true);
    expect(
      await AgentTeamModel.getUserAccessibleAgentIds(reader.id, false),
    ).toContain(agent.id);
    expect(
      (await ResourcePermissionPolicyModel.find(key))?.legacySharingMigrated,
    ).toBe(false);
    expect(
      await ResourcePermissions.resolveAll({
        organizationId: org.id,
        userId: reader.id,
      }),
    ).toEqual([]);

    config.resourcePermissions.enabled = true;
    // On again: the same stored revocation is authoritative once more, so the
    // transition is a switch rather than a one-way door.
    expect(await AgentTeamModel.userHasAgentAccess(access)).toBe(false);
    expect(
      await AgentTeamModel.getUserAccessibleAgentIds(reader.id, false),
    ).not.toContain(agent.id);
  });
});
