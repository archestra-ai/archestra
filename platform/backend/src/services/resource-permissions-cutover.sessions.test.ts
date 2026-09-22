// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { enterpriseTier } from "@/enterprise-tier";
import A2AContextModel from "@/models/a2a/context";
import A2ATaskModel from "@/models/a2a/task";
import AgentRunModel from "@/models/agent-run";
import AgentRunShareModel from "@/models/agent-run-share";
import ConversationModel from "@/models/conversation";
import ConversationShareModel from "@/models/conversation-share";
import ProjectModel from "@/models/project";
import ProjectShareModel from "@/models/project-share";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";
import { expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

for (const resource of ["conversation", "agentRun"] as const) {
  for (const visibility of [
    "private",
    "organization",
    "team",
    "user",
  ] as const) {
    test(`${resource} preserves ${visibility} sharing and revocations across repeated conversion`, async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeTeam,
      makeTeamMember,
    }) => {
      enterpriseTier.setUserCountForTesting(0);
      const org = await makeOrganization({ legacyPermissions: true });
      const owner = await makeUser();
      const recipient = await makeUser();
      const outsider = await makeUser();
      for (const user of [owner, recipient, outsider])
        await makeMember(user.id, org.id);
      const agent = await makeAgent({ organizationId: org.id });
      const team = await makeTeam(org.id, owner.id);
      await makeTeamMember(team.id, recipient.id);
      const context = await A2AContextModel.create({
        actorKind: "user",
        actorId: owner.id,
      });
      const task = await A2ATaskModel.create({
        contextId: context.id,
        agentId: agent.id,
        state: "TASK_STATE_COMPLETED",
      });
      const chat = await ConversationModel.create({
        userId: owner.id,
        organizationId: org.id,
        agentId: agent.id,
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
      const scope = resource === "conversation" ? chat.id : task.id;
      const key = { organizationId: org.id, resource, scope };
      if (visibility !== "private") {
        const share = {
          organizationId: org.id,
          createdByUserId: owner.id,
          visibility,
          teamIds: visibility === "team" ? [team.id] : [],
          userIds: visibility === "user" ? [recipient.id] : [],
        };
        if (resource === "conversation")
          await ConversationShareModel.upsert({
            ...share,
            conversationId: scope,
          });
        else await AgentRunShareModel.upsert({ ...share, taskId: scope });
      }
      const before = await ResourcePermissions.getPolicy({
        ...key,
        userId: owner.id,
      });
      expect(before.effectiveActions).toEqual(["read", "manage-permissions"]);
      await runScopedResourcePermissionCutover();
      const migrated = await ResourcePermissionPolicyModel.find(key);
      expect(migrated?.legacySharingMigrated).toBe(true);
      for (const [user, expected] of [
        [owner, true],
        [recipient, visibility !== "private"],
        [outsider, visibility === "organization"],
      ] as const) {
        expect(
          await ResourcePermissions.allows({
            ...key,
            userId: user.id,
            action: "read",
          }),
        ).toBe(expected);
        expect(
          await ResourcePermissions.allows({
            ...key,
            userId: user.id,
            action: "use",
          }),
        ).toBe(false);
        const readable =
          resource === "conversation"
            ? await ConversationShareModel.findAccessibleByConversationId({
                organizationId: org.id,
                userId: user.id,
                conversationId: scope,
              })
            : await AgentRunShareModel.findAccessibleByTaskId({
                organizationId: org.id,
                userId: user.id,
                taskId: scope,
              });
        expect(!!readable).toBe(expected);
      }
      await ResourcePermissions.updatePolicy({
        ...key,
        userId: owner.id,
        revision: migrated?.revision ?? 0,
        grants: [
          {
            subject: { type: "user", id: owner.id },
            actions: ["read", "manage-permissions"],
          },
        ],
      });
      const revoked = await ResourcePermissionPolicyModel.find(key);
      await runScopedResourcePermissionCutover();
      expect(await ResourcePermissionPolicyModel.find(key)).toEqual(revoked);
      expect(
        await ResourcePermissions.allows({
          ...key,
          userId: recipient.id,
          action: "read",
        }),
      ).toBe(false);
      const stillReadable =
        resource === "conversation"
          ? await ConversationShareModel.findAccessibleByConversationId({
              organizationId: org.id,
              userId: recipient.id,
              conversationId: scope,
            })
          : await AgentRunShareModel.findAccessibleByTaskId({
              organizationId: org.id,
              userId: recipient.id,
              taskId: scope,
            });
      expect(!!stillReadable).toBe(false);
    });
  }
}

test("new chat grants support mixed principals without creating a legacy share and cannot expose locked chats", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  makeTeam,
  makeTeamMember,
}) => {
  enterpriseTier.setUserCountForTesting(0);
  const org = await makeOrganization();
  const owner = await makeUser();
  const reader = await makeUser();
  const outsider = await makeUser();
  for (const user of [owner, reader, outsider])
    await makeMember(user.id, org.id);
  const agent = await makeAgent({ organizationId: org.id });
  const team = await makeTeam(org.id, owner.id);
  await makeTeamMember(team.id, reader.id);
  const chat = await ConversationModel.create({
    userId: owner.id,
    organizationId: org.id,
    agentId: agent.id,
  });
  const key = {
    organizationId: org.id,
    resource: "conversation" as const,
    scope: chat.id,
  };
  const grants = [
    {
      subject: { type: "user" as const, id: owner.id },
      actions: ["read" as const, "manage-permissions" as const],
    },
    {
      subject: { type: "team" as const, id: team.id },
      actions: ["read" as const],
    },
  ];
  await ResourcePermissions.updatePolicy({
    ...key,
    userId: owner.id,
    revision: 0,
    grants,
  });
  expect(
    await ConversationShareModel.findByConversationId({
      organizationId: org.id,
      conversationId: chat.id,
    }),
  ).toBeNull();
  expect(
    await ConversationModel.findAccessibleById({
      id: chat.id,
      userId: reader.id,
      organizationId: org.id,
      canReadOthersViaProject: async () => false,
    }),
  ).not.toBeNull();
  expect(
    await ConversationModel.findAccessibleById({
      id: chat.id,
      userId: outsider.id,
      organizationId: org.id,
      canReadOthersViaProject: async () => false,
    }),
  ).toBeNull();
  await expect(
    ResourcePermissions.updatePolicy({
      ...key,
      userId: reader.id,
      revision: 1,
      grants: [],
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    ResourcePermissions.updatePolicy({
      ...key,
      userId: owner.id,
      revision: 1,
      grants: [{ subject: { type: "user", id: reader.id }, actions: ["use"] }],
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  const locked = await ConversationModel.create({
    userId: owner.id,
    organizationId: org.id,
    agentId: agent.id,
    lockedChat: true,
  });
  await expect(
    ResourcePermissions.updatePolicy({
      ...key,
      scope: locked.id,
      userId: owner.id,
      revision: 0,
      grants,
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
});

test("project permission revocation removes inherited session reads and project discovery", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
}) => {
  enterpriseTier.setUserCountForTesting(0);
  const org = await makeOrganization({ legacyPermissions: true });
  const owner = await makeUser();
  const reader = await makeUser();
  for (const user of [owner, reader])
    await makeMember(user.id, org.id, {
      role: user.id === owner.id ? "admin" : "member",
    });
  const agent = await makeAgent({ organizationId: org.id });
  const project = await ProjectModel.create({
    organizationId: org.id,
    userId: owner.id,
    name: "Session review",
  });
  await ProjectShareModel.upsert({
    organizationId: org.id,
    projectId: project.id,
    createdByUserId: owner.id,
    visibility: "organization",
    teamIds: [],
  });
  const chat = await ConversationModel.create({
    organizationId: org.id,
    userId: owner.id,
    agentId: agent.id,
    projectId: project.id,
  });
  await runScopedResourcePermissionCutover();
  const readChat = () =>
    ConversationModel.findAccessibleById({
      id: chat.id,
      organizationId: org.id,
      userId: reader.id,
      canReadOthersViaProject: async () => true,
    });
  expect(await readChat()).not.toBeNull();
  expect(
    await ProjectShareModel.listAccessibleProjects({
      organizationId: org.id,
      userId: reader.id,
    }),
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: project.id })]),
  );
  const policy = await ResourcePermissions.getPolicy({
    organizationId: org.id,
    userId: owner.id,
    resource: "project",
    scope: project.id,
  });
  await ResourcePermissions.updatePolicy({
    organizationId: org.id,
    userId: owner.id,
    resource: "project",
    scope: project.id,
    revision: policy.revision,
    grants: [
      {
        subject: { type: "user", id: owner.id },
        actions: ["read", "use", "update", "delete", "manage-permissions"],
      },
    ],
  });
  expect(await readChat()).toBeNull();
  expect(
    await ProjectShareModel.listAccessibleProjects({
      organizationId: org.id,
      userId: reader.id,
    }),
  ).toEqual([]);
});

test("project wildcard access cannot reveal private chats, while explicit recipients inherit and revoke", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const owner = await makeUser();
  const reader = await makeUser();
  await makeMember(owner.id, org.id);
  await makeMember(reader.id, org.id);
  const project = await ProjectModel.create({
    organizationId: org.id,
    userId: owner.id,
    name: "Private sessions",
  });
  const agent = await makeAgent({ organizationId: org.id });
  const chat = await ConversationModel.create({
    organizationId: org.id,
    userId: owner.id,
    agentId: agent.id,
    projectId: project.id,
  });
  await runScopedResourcePermissionCutover();
  const wildcardKey = {
    organizationId: org.id,
    resource: "project" as const,
    scope: "*",
  };
  const wildcard = await ResourcePermissionPolicyModel.find(wildcardKey);
  await ResourcePermissionPolicyModel.replace({
    ...wildcardKey,
    revision: wildcard?.revision ?? 0,
    grants: [{ subject: { type: "user", id: reader.id }, actions: ["read"] }],
  });
  const readChat = () =>
    ConversationModel.findAccessibleById({
      id: chat.id,
      organizationId: org.id,
      userId: reader.id,
      canReadOthersViaProject: async () => true,
    });
  expect(
    await ProjectShareModel.userCanAccessProject({
      project,
      organizationId: org.id,
      userId: reader.id,
    }),
  ).toBe(true);
  expect(await readChat()).toBeNull();
  const key = { ...wildcardKey, scope: project.id };
  const policy = await ResourcePermissionPolicyModel.find(key);
  const direct = await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy?.revision ?? 0,
    grants: [{ subject: { type: "user", id: reader.id }, actions: ["read"] }],
  });
  expect(await readChat()).not.toBeNull();
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: direct?.revision ?? 0,
    grants: [],
  });
  expect(await readChat()).toBeNull();
  expect(
    await ProjectShareModel.userCanAccessProject({
      project,
      organizationId: org.id,
      userId: reader.id,
    }),
  ).toBe(true);
});
