// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

describe("AgentModel.findAccessibleDelegationTargets", () => {
  test("offers an agent the caller holds a use grant on, whatever its retired scope says", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const caller = await makeUser();
    await makeMember(caller.id, org.id);
    const callerAgent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    // Organization-wide by the retired field; its grants reach nobody.
    const target = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      scope: "org",
    });
    const key = {
      organizationId: org.id,
      resource: "agent" as const,
      scope: target.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    const emptied = await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    const targets = async () =>
      (
        await AgentModel.findAccessibleDelegationTargets({
          userId: caller.id,
          isAdmin: false,
          organizationId: org.id,
          excludeAgentId: callerAgent.id,
          environmentId: null,
        })
      ).map((agent) => agent.id);

    expect(await targets()).not.toContain(target.id);

    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: emptied?.revision ?? 0,
      grants: [
        { subject: { type: "user", id: caller.id }, actions: ["read", "use"] },
      ],
    });
    expect(await targets()).toContain(target.id);
  });
});
