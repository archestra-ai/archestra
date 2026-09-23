// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { describe, expect, test } from "@/test";
import PluginModel from "./plugin";
import PluginTeamModel from "./plugin-team";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

describe("PluginTeamModel.getUserAccessiblePluginIds", () => {
  test("lists a plugin through a read grant", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const member = await makeUser();
    await makeMember(author.id, org.id);
    await makeMember(member.id, org.id);
    const plugin = await createPlugin({
      organizationId: org.id,
      userId: author.id,
      // Shared with nobody by grant.
      initialPermissionGrants: [],
    });
    const list = (userId?: string) =>
      PluginTeamModel.getUserAccessiblePluginIds({
        organizationId: org.id,
        userId,
      });

    expect(await list(author.id)).toEqual([plugin.id]);
    expect(await list(member.id)).toEqual([]);
    // A caller with no user of its own reaches only what is published to the
    // organization at large.
    expect(await list()).toEqual([]);

    const key = {
      organizationId: org.id,
      resource: "plugin" as const,
      scope: plugin.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [
        ...(policy?.grants ?? []),
        {
          subject: { type: "organization", id: "*" },
          actions: ["read", "use"],
        },
      ],
    });
    expect(await list(member.id)).toEqual([plugin.id]);
    expect(await list()).toEqual([plugin.id]);
  });
});

async function createPlugin(params: {
  organizationId: string;
  userId: string;
  initialPermissionGrants: [];
}) {
  const plugin = await PluginModel.create({
    organizationId: params.organizationId,
    userId: params.userId,
    input: {
      displayName: `Plugin ${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      clientType: "claude-code",
      files: [
        {
          path: "hooks/hooks.json",
          content: "{}",
          encoding: "utf8",
          mode: "100644",
        },
      ],
    },
    initialPermissionGrants: params.initialPermissionGrants,
  });
  if (!plugin) throw new Error("failed to create plugin");
  return plugin;
}
