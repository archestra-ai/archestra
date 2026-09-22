// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import A2AContextModel from "@/models/a2a/context";
import A2ATaskModel from "@/models/a2a/task";
import AgentModel from "@/models/agent";
import AgentRunModel from "@/models/agent-run";
import ConversationModel from "@/models/conversation";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ServiceAccountModel from "@/models/service-account";
import TeamModel from "@/models/team";
import { describe, expect, test } from "@/test";
import { ResourcePermissions } from "./resource-permissions";

describe("resource permissions", () => {
  test("retired team-relative policies cannot upgrade direct team access or leak into capabilities", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "editor" });
    const team = await makeTeam(org.id, user.id);
    await TeamModel.addMember(team.id, user.id);
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: user.id,
      agentType: "agent",
      scope: "personal",
    });
    const context = {
      organizationId: org.id,
      userId: user.id,
      resource: "agent" as const,
      scope: agent.id,
    };
    await replacePolicy({
      ...context,
      scope: "teams:*",
      revision: 0,
      grants: [
        {
          subject: { type: "role", id: "editor" },
          actions: ["use", "update", "manage-permissions"],
        },
      ],
    });
    const grants = [
      {
        subject: { type: "team" as const, id: team.id },
        actions: ["read" as const],
      },
    ];
    // Sharing view access requires only view + permission-management authority,
    // regardless of obsolete rules still present during an upgrade.
    const policy = await ResourcePermissionPolicyModel.find(context);
    await ResourcePermissions.replace({
      ...context,
      revision: policy?.revision ?? 0,
      grants,
      authority: [
        { ...context, action: "read" },
        { ...context, action: "manage-permissions" },
      ],
    });
    expect((await ResourcePermissionPolicyModel.find(context))?.grants).toEqual(
      grants,
    );
    expect(
      await ResourcePermissions.allows({ ...context, action: "read" }),
    ).toBe(true);
    expect(
      await ResourcePermissions.allows({ ...context, action: "update" }),
    ).toBe(false);
    const capabilities = await ResourcePermissions.resolveAll(context);
    expect(capabilities.some((grant) => grant.scope === "teams:*")).toBe(false);
    expect(
      capabilities.some(
        (grant) => grant.resource === "agent" && grant.action === "update",
      ),
    ).toBe(false);
    expect(await AgentModel.findUsableChatopsAgents(context)).toEqual([]);
    const display = await ResourcePermissions.getPolicy(context);
    expect(
      display.inheritedGrants.every((grant) => grant.sourceScope === "*"),
    ).toBe(true);
    await replacePolicy({
      ...context,
      revision: 0,
      grants: [
        { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
      ],
    });
    expect(await AgentModel.findUsableChatopsAgents(context)).toEqual([
      { id: agent.id, name: agent.name },
    ]);
    const subjects = [{ type: "role" as const, id: "editor" }];
    expect(
      (
        await ResourcePermissionPolicyModel.findForSubjects({
          ...context,
          subjects,
        })
      ).some((policy) => policy.scope === "teams:*"),
    ).toBe(false);
  });
  test("service accounts receive exact and wildcard grants, and disabled or foreign accounts cannot use them", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const account = await ServiceAccountModel.create({
      createdBy: null,
      organizationId: org.id,
      name: "Release automation",
      role: "member",
    });
    const context = {
      organizationId: org.id,
      userId: `service-account:${account.id}`,
      resource: "mcpRegistry" as const,
      scope: "00000000-0000-4000-8000-000000000001",
    };
    const subject = { type: "serviceAccount" as const, id: account.id };
    await replacePolicy({
      ...context,
      revision: 0,
      grants: [{ subject, actions: ["update"] }],
    });
    await replacePolicy({
      ...context,
      scope: "*",
      revision: 0,
      grants: [{ subject, actions: ["read"] }],
    });
    expect(
      await ResourcePermissions.allows({ ...context, action: "update" }),
    ).toBe(true);
    expect(
      await ResourcePermissions.allows({
        ...context,
        scope: "00000000-0000-4000-8000-000000000002",
        action: "update",
      }),
    ).toBe(false);
    expect(
      await ResourcePermissions.allows({
        ...context,
        scope: "00000000-0000-4000-8000-000000000002",
        action: "read",
      }),
    ).toBe(true);
    expect(
      await ResourcePermissions.allows({
        ...context,
        organizationId: other.id,
        action: "read",
      }),
    ).toBe(false);
    await ServiceAccountModel.update(account.id, org.id, { disabled: true });
    expect(
      await ResourcePermissions.allows({ ...context, action: "read" }),
    ).toBe(false);
    await expect(
      ResourcePermissions.validateRecipients({
        organizationId: org.id,
        resource: "agent",
        grants: [{ subject, actions: ["read"] }],
      }),
    ).rejects.toThrow("disabled");
  });
  test("inherits grants down the team hierarchy and revokes them when membership ends", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const creator = await makeUser();
    await makeMember(user.id, org.id);
    const parent = await TeamModel.create({
      name: "Engineering",
      organizationId: org.id,
      createdBy: creator.id,
    });
    const child = await TeamModel.create({
      name: "Frontend",
      organizationId: org.id,
      createdBy: creator.id,
      parentId: parent.id,
    });
    await TeamModel.addMember(child.id, user.id);
    const context = {
      organizationId: org.id,
      userId: user.id,
      resource: "agent" as const,
      scope: "00000000-0000-4000-8000-000000000001",
    };
    await replacePolicy({
      ...context,
      revision: 0,
      grants: [{ subject: { type: "team", id: parent.id }, actions: ["read"] }],
    });
    expect(
      await ResourcePermissions.allows({ ...context, action: "read" }),
    ).toBe(true);
    expect(
      await ResourcePermissions.allows({ ...context, action: "update" }),
    ).toBe(false);
    await TeamModel.removeMember(child.id, user.id);
    expect(
      await ResourcePermissions.allows({ ...context, action: "read" }),
    ).toBe(false);
  });

  test("an organization grant never grants access to nonmembers", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, otherOrg.id);
    const context = {
      organizationId: org.id,
      userId: user.id,
      resource: "mcpRegistry" as const,
      scope: "*" as const,
    };
    await replacePolicy({
      ...context,
      revision: 0,
      grants: [
        { subject: { type: "organization", id: "*" }, actions: ["read"] },
      ],
    });
    expect(
      await ResourcePermissions.allows({ ...context, action: "read" }),
    ).toBe(false);
    await makeMember(user.id, org.id);
    expect(
      await ResourcePermissions.allows({ ...context, action: "read" }),
    ).toBe(true);
  });

  test("role recipients follow inherited assignments using immutable role ids", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      role: "resource_reader",
      permission: {},
    });
    await makeMember(user.id, org.id, { role: role.role });
    const context = {
      organizationId: org.id,
      userId: user.id,
      resource: "skill" as const,
      scope: "*" as const,
    };
    await replacePolicy({
      ...context,
      revision: 0,
      grants: [{ subject: { type: "role", id: role.id }, actions: ["read"] }],
    });
    expect(
      await ResourcePermissions.allows({ ...context, action: "read" }),
    ).toBe(true);
    expect(
      await ResourcePermissions.allows({ ...context, action: "delete" }),
    ).toBe(false);
  });

  test("rejects foreign recipients and rejects delegation beyond the caller's scope", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, other.id);
    const key = {
      organizationId: org.id,
      userId: user.id,
      resource: "agent" as const,
      scope: "00000000-0000-4000-8000-000000000001",
    };
    const grant = {
      subject: { type: "user" as const, id: user.id },
      actions: ["read" as const],
    };
    await expect(
      ResourcePermissions.validateRecipients({
        organizationId: org.id,
        resource: "agent",
        grants: [grant],
      }),
    ).rejects.toThrow("does not exist");
    await expect(
      ResourcePermissions.replace({
        ...key,
        revision: 0,
        grants: [grant],
        authority: [{ ...key, action: "manage-permissions" }],
      }),
    ).rejects.toThrow("only grant permissions you hold");
    expect(await ResourcePermissionPolicyModel.find(key)).toBeNull();
  });

  test("refuses a grant that is not one of the resource's permission levels", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const subject = { type: "user" as const, id: user.id };
    // Between Can edit and Full access: manage-permissions without delete.
    await expect(
      ResourcePermissions.validateRecipients({
        organizationId: org.id,
        resource: "agent",
        grants: [
          {
            subject,
            actions: ["read", "use", "update", "manage-permissions"],
          },
        ],
      }),
    ).rejects.toThrow("permission levels this resource offers");
    // A preset of one resource is not a preset of every resource.
    await expect(
      ResourcePermissions.validateRecipients({
        organizationId: org.id,
        resource: "agent",
        grants: [{ subject, actions: ["read", "manage-permissions"] }],
      }),
    ).rejects.toThrow("permission levels this resource offers");
    await expect(
      ResourcePermissions.validateRecipients({
        organizationId: org.id,
        resource: "conversation",
        grants: [{ subject, actions: ["read", "manage-permissions"] }],
      }),
    ).resolves.toBeUndefined();
  });

  test("a new chat and a new agent run give their owner the session manage preset, and only them", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const other = await makeUser();
    await makeMember(owner.id, org.id);
    await makeMember(other.id, org.id);
    const agent = await makeAgent({ organizationId: org.id });
    const chat = await ConversationModel.create({
      userId: owner.id,
      organizationId: org.id,
      agentId: agent.id,
    });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: owner.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_COMPLETED",
    });
    await AgentRunModel.create({
      organizationId: org.id,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: owner.id,
      actorUserId: owner.id,
      workloadName: `test-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "test",
    });
    for (const [resource, scope] of [
      ["conversation", chat.id],
      ["agentRun", task.id],
    ] as const) {
      const key = { organizationId: org.id, resource, scope };
      const policy = await ResourcePermissionPolicyModel.find(key);
      // Sessions have no use, update or delete, so the manage preset stores
      // as read plus manage-permissions.
      expect(policy?.grants).toEqual([
        {
          subject: { type: "user", id: owner.id },
          actions: ["read", "manage-permissions"],
        },
      ]);
      expect(policy?.legacySharingMigrated).toBe(true);
      // The owner can open the share editor straight away; nobody else can.
      const effective = await ResourcePermissions.getPolicy({
        ...key,
        userId: owner.id,
      });
      expect(effective.effectiveActions).toEqual([
        "read",
        "manage-permissions",
      ]);
      await expect(
        ResourcePermissions.getPolicy({ ...key, userId: other.id }),
      ).rejects.toMatchObject({ statusCode: 403 });
    }
  });
});

async function replacePolicy(
  params: Parameters<typeof ResourcePermissionPolicyModel.replace>[0],
) {
  const current = await ResourcePermissionPolicyModel.find(params);
  const updated = await ResourcePermissionPolicyModel.replace({
    ...params,
    revision: current?.revision ?? 0,
  });
  expect(updated).not.toBeNull();
  return updated;
}
