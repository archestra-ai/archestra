// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { randomUUID } from "node:crypto";
import {
  agentRuntimePermissionScope,
  buildCustomAgentRuntime,
} from "@archestra/shared";
import db from "@/database";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import SecretModel from "@/models/secret";
import { describe, expect, test } from "@/test";
import { upgradeAgentRuntimeLocks } from "./agent-runtime-lock-upgrade";

const claudeCode = agentRuntimePermissionScope({
  kind: "built-in",
  id: "claude-code",
});
const codex = agentRuntimePermissionScope({ kind: "built-in", id: "codex" });

/** An organization as 1.4 left it, after migration 0640 ran. */
async function seedUpgradedOrganization(params: {
  organizationId: string;
  roleId: string;
  locked: boolean;
}) {
  const locked = randomUUID();
  const open = randomUUID();
  const template = (id: string, name: string, isLocked: boolean) => ({
    id,
    name,
    description: "",
    icon: null,
    hidden: false,
    position: 0,
    locked: isLocked,
    runtime: {
      ...buildCustomAgentRuntime({ image: `registry.example.com/${name}:v1` }),
      privileged: false,
      environment: null,
    },
  });
  await SecretModel.create({
    name: `agent-runtime-templates:${params.organizationId}`,
    secret: {
      revision: 3,
      templates: [
        template(locked, "pinned", params.locked),
        template(open, "open", false),
      ],
      builtIns: {
        "claude-code": { locked: params.locked, settings: { ttlHours: 6 } },
      },
    },
  });
  const key = {
    organizationId: params.organizationId,
    resource: "agentRuntime" as const,
    scope: "*",
  };
  const policy = await ResourcePermissionPolicyModel.find(key);
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy?.revision ?? 0,
    grants: [
      ...(policy?.grants ?? []),
      {
        subject: { type: "role", id: params.roleId },
        actions: ["read", "use", "configure"],
      },
    ],
  });
  return { locked, open };
}

const grantsOf = async (organizationId: string, scope: string) =>
  (
    await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "agentRuntime",
      scope,
    })
  )?.grants ?? [];

describe("upgrading runtime locks to permissions", () => {
  test("keeps locked runtimes out of a configure-runtime role's reach", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const role = await makeCustomRole(org.id);
    const { locked, open } = await seedUpgradedOrganization({
      organizationId: org.id,
      roleId: role.id,
      locked: true,
    });

    await db.transaction((tx) => upgradeAgentRuntimeLocks(tx));

    const roleGrant = (grants: Awaited<ReturnType<typeof grantsOf>>) =>
      grants.find((grant) => grant.subject.id === role.id)?.actions;
    expect(roleGrant(await grantsOf(org.id, "*"))).toEqual(["read", "use"]);
    expect(
      (await grantsOf(org.id, "*")).find(
        (grant) => grant.subject.id === "admin",
      )?.actions,
    ).toContain("configure");
    for (const scope of [codex, open])
      expect(roleGrant(await grantsOf(org.id, scope))).toEqual([
        "read",
        "use",
        "configure",
      ]);
    for (const scope of [claudeCode, locked])
      expect(roleGrant(await grantsOf(org.id, scope))).toBeUndefined();

    // The retired flags are gone; the settings themselves are kept.
    const settings = await AgentRuntimeTemplateModel.getSettings(org.id);
    expect(settings.builtIns["claude-code"]).toEqual({
      settings: { ttlHours: 6 },
    });
    const stored = await SecretModel.findByName(
      `agent-runtime-templates:${org.id}`,
    );
    expect(JSON.stringify(stored?.secret)).not.toContain('"locked"');
  });

  test("leaves an organization that never locked a runtime as migrated", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const role = await makeCustomRole(org.id);
    await seedUpgradedOrganization({
      organizationId: org.id,
      roleId: role.id,
      locked: false,
    });
    const before = await grantsOf(org.id, "*");

    await db.transaction((tx) => upgradeAgentRuntimeLocks(tx));

    expect(await grantsOf(org.id, "*")).toEqual(before);
    expect(await grantsOf(org.id, codex)).toEqual([]);
  });
});
