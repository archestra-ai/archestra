// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type ResourcePermissionGrant,
  ROLE_ASSIGNMENT_BLOCKED_CODE,
  type ScopedResource,
} from "@archestra/shared";
import { adminPermissions } from "@archestra/shared/access-control";
import A2AContextModel from "@/models/a2a/context";
import A2ATaskModel from "@/models/a2a/task";
import AgentModel from "@/models/agent";
import AgentRunModel from "@/models/agent-run";
import ConversationModel from "@/models/conversation";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { ResourcePermissions } from "./resource-permissions";

/**
 * Assigning a role or team hands its holder every grant the role or team
 * carries, so the caller must be able to grant each of them. These cover the
 * objects no organization-wide authority reaches, where that rule cannot
 * apply, and the ordinary objects where it still must.
 */
describe("assigning a role that objects are shared with", () => {
  test("an administrator can assign Member after members share their own chat, agent run and provider key with it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    const owner = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    await makeMember(owner.id, org.id, { role: "member" });
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
    const secret = await makeSecret();
    const ownKey = await makeLlmProviderApiKey(org.id, secret.id, {
      userId: owner.id,
    });

    // Each owner shares through the editor, as the chat share dialog does.
    for (const [resource, scope, actions] of [
      ["conversation", chat.id, ["read"]],
      ["agentRun", task.id, ["read"]],
      ["llmProviderApiKey", ownKey.id, ["read", "use"]],
    ] as const) {
      await shareWithMember({
        organizationId: org.id,
        userId: owner.id,
        resource,
        scope,
        actions: [...actions],
      });
    }

    await expect(
      ResourcePermissions.validateSubjectAssignment({
        organizationId: org.id,
        userId: admin.id,
        subjects: [{ type: "role", id: "member" }],
      }),
    ).resolves.toBeUndefined();
  });

  test("a deleted object shared with Member does not stop an administrator assigning Member", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      access: "org",
    });
    await AgentModel.delete(agent.id);

    await expect(
      ResourcePermissions.validateSubjectAssignment({
        organizationId: org.id,
        userId: admin.id,
        subjects: [{ type: "role", id: "member" }],
      }),
    ).resolves.toBeUndefined();
  });

  test("a role carrying access to an agent the caller cannot share is still refused", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const caller = await makeUser();
    await makeMember(author.id, org.id, { role: "member" });
    await makeMember(caller.id, org.id, { role: "member" });
    const role = await makeCustomRole(org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: author.id,
      agentType: "agent",
      access: "personal",
    });
    await shareWith({
      organizationId: org.id,
      userId: author.id,
      resource: "agent",
      scope: agent.id,
      grant: {
        subject: { type: "role", id: role.id },
        actions: ["read", "use", "update", "delete", "manage-permissions"],
      },
    });

    await expect(
      ResourcePermissions.validateSubjectAssignment({
        organizationId: org.id,
        userId: caller.id,
        subjects: [{ type: "role", id: role.id }],
      }),
    ).rejects.toThrow("You can only share an item if you can manage");
  });

  test("a custom role that can edit organization-wide policies can assign Member", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      access: "org",
    });
    // Holds every admin permission but none of the `*` grants an
    // organization seeds for the built-in admin roles.
    const role = await makeCustomRole(org.id, { permission: adminPermissions });
    const caller = await makeUser();
    await makeMember(caller.id, org.id, { role: role.role });

    await expect(
      ResourcePermissions.validateSubjectAssignment({
        organizationId: org.id,
        userId: caller.id,
        subjects: [{ type: "role", id: "member" }],
      }),
    ).resolves.toBeUndefined();
  });

  test("a refusal names each object the caller cannot share", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      access: "org",
    });
    const role = await makeCustomRole(org.id, {
      permission: { serviceAccount: ["read", "create"] },
    });
    const caller = await makeUser();
    await makeMember(caller.id, org.id, { role: role.role });

    const error = await ResourcePermissions.validateSubjectAssignment({
      organizationId: org.id,
      userId: caller.id,
      subjects: [{ type: "role", id: "member" }],
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(403);
    expect((error as ApiError).internalCode).toBe(ROLE_ASSIGNMENT_BLOCKED_CODE);
    expect((error as ApiError).details).toEqual({
      subjectType: "role",
      items: [
        {
          resource: "agent",
          scope: agent.id,
          name: agent.name,
          missing: ["manage-permissions"],
        },
      ],
      total: 1,
    });
  });
});

// === Internal helpers ===

async function shareWithMember(params: {
  organizationId: string;
  userId: string;
  resource: ScopedResource;
  scope: string;
  actions: ResourcePermissionGrant["actions"];
}) {
  await shareWith({
    ...params,
    grant: { subject: { type: "role", id: "member" }, actions: params.actions },
  });
}

async function shareWith(params: {
  organizationId: string;
  userId: string;
  resource: ScopedResource;
  scope: string;
  grant: ResourcePermissionGrant;
}) {
  const current = await ResourcePermissionPolicyModel.find(params);
  await ResourcePermissions.updatePolicy({
    ...params,
    revision: current?.revision ?? 0,
    grants: [...(current?.grants ?? []), params.grant],
  });
}
