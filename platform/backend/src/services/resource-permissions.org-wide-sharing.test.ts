// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  DEFAULT_CREDENTIAL_GRANTS,
  type ResourcePermissionGrant,
  type ScopedResource,
} from "@archestra/shared";
import ConversationModel from "@/models/conversation";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { createRuntimeCredentialDefinition } from "@/services/agent-runtime/runtime-credentials";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { ResourcePermissions } from "./resource-permissions";

const EVERYONE = { type: "organization", id: "*" } as const;
const MEMBER_ROLE = { type: "role", id: "member" } as const;
const FULL: ResourcePermissionGrant["actions"] = [
  "read",
  "use",
  "update",
  "delete",
  "manage-permissions",
];

describe("making an object org-wide", () => {
  test("a member who manages one registry entry cannot share it with everyone or a role", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      access: "personal",
    });
    const context = {
      organizationId: org.id,
      userId: member.id,
      resource: "mcpRegistry" as const,
      scope: catalog.id,
    };
    const own = {
      subject: { type: "user" as const, id: member.id },
      actions: FULL,
    };
    await seedPolicy({ ...context, grants: [own] });

    for (const added of [
      { subject: EVERYONE, actions: ["read", "use"] },
      { subject: MEMBER_ROLE, actions: ["read", "use"] },
      { subject: { type: "role", id: "editor" }, actions: ["read"] },
    ] satisfies ResourcePermissionGrant[]) {
      await expect(save({ ...context, grants: [own, added] })).rejects.toThrow(
        expect.objectContaining({
          statusCode: 403,
          message:
            "Only someone with Full access to every MCP registry entry can share it with everyone in the organization or with a role.",
        }),
      );
    }
    expect((await policyOf(context))?.grants).toEqual([own]);
    expect(
      (await ResourcePermissions.getPolicy(context)).canShareOrganizationWide,
    ).toBe(false);
  });

  test("a member may keep, lower, or remove an org-wide grant, but not raise it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      access: "personal",
    });
    const context = {
      organizationId: org.id,
      userId: member.id,
      resource: "agent" as const,
      scope: agent.id,
    };
    const own = {
      subject: { type: "user" as const, id: member.id },
      actions: FULL,
    };
    const everyone = { subject: EVERYONE, actions: ["read", "use"] as const };
    const role = { subject: MEMBER_ROLE, actions: ["read"] as const };
    await seedPolicy({
      ...context,
      grants: [
        own,
        { ...everyone, actions: [...everyone.actions] },
        { ...role, actions: [...role.actions] },
      ],
    });

    // Raising the role grant is new reach, so it is refused.
    await expect(
      save({
        ...context,
        grants: [
          own,
          { ...everyone, actions: ["read", "use"] },
          { subject: MEMBER_ROLE, actions: ["read", "use"] },
        ],
      }),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 403 }));
    // Keeping both while sharing elsewhere is fine.
    await save({
      ...context,
      grants: [
        own,
        { ...everyone, actions: ["read", "use"] },
        { subject: MEMBER_ROLE, actions: ["read"] },
      ],
    });
    // Lowering everyone to view, then removing the role grant.
    await save({
      ...context,
      grants: [
        own,
        { subject: EVERYONE, actions: ["read"] },
        { subject: MEMBER_ROLE, actions: ["read"] },
      ],
    });
    await save({
      ...context,
      grants: [own, { subject: EVERYONE, actions: ["read"] }],
    });
    expect((await policyOf(context))?.grants).toEqual([
      own,
      { subject: EVERYONE, actions: ["read"] },
    ]);
    // And raising it back to use is refused again.
    await expect(
      save({
        ...context,
        grants: [own, { subject: EVERYONE, actions: ["read", "use"] }],
      }),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  test("a member shares with their own teams and with people, not with other teams or service accounts", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeServiceAccount,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id);
    const colleague = await makeUser();
    await makeMember(colleague.id, org.id);
    const team = await makeTeam(org.id, member.id);
    await makeTeamMember(team.id, member.id);
    const otherTeam = await makeTeam(org.id, colleague.id);
    const account = await makeServiceAccount(org.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      access: "personal",
    });
    const context = {
      organizationId: org.id,
      userId: member.id,
      resource: "mcpRegistry" as const,
      scope: catalog.id,
    };
    const own = {
      subject: { type: "user" as const, id: member.id },
      actions: FULL,
    };
    await seedPolicy({ ...context, grants: [own] });
    const grants: ResourcePermissionGrant[] = [
      own,
      { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
      { subject: { type: "user", id: colleague.id }, actions: ["read", "use"] },
    ];
    await save({ ...context, grants });
    expect((await policyOf(context))?.grants).toEqual(grants);

    // Adding every team would reach close to everyone.
    await expect(
      save({
        ...context,
        grants: [
          ...grants,
          {
            subject: { type: "team", id: otherTeam.id },
            actions: ["read", "use"],
          },
        ],
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        statusCode: 403,
        message:
          "Only someone with Full access to every MCP registry entry can share it with a team they are not in.",
      }),
    );
    // A member cannot see service accounts, so cannot pick one either.
    await expect(
      save({
        ...context,
        grants: [
          ...grants,
          {
            subject: { type: "serviceAccount", id: account.id },
            actions: ["read", "use"],
          },
        ],
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        statusCode: 403,
        message:
          "Sharing with a service account needs permission to see service accounts.",
      }),
    );
    expect((await policyOf(context))?.grants).toEqual(grants);
  });

  test("an admin may make every kind of object org-wide, their own personal provider key included", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const everyone = [
      { subject: EVERYONE, actions: ["read", "use"] },
    ] satisfies ResourcePermissionGrant[];
    for (const resource of [
      "mcpRegistry",
      "agent",
      "mcpGateway",
      "app",
      "skill",
      "llmProviderApiKey",
      "knowledgeFile",
    ] satisfies ScopedResource[]) {
      await expect(
        ResourcePermissions.validateInitialGrants({
          organizationId: org.id,
          userId: admin.id,
          resource,
          grants: everyone,
          target: { id: crypto.randomUUID(), name: "New", authorId: admin.id },
        }),
        resource,
      ).resolves.toBeUndefined();
    }
    // A personal key is reserved to its owner: no `*` grant reaches it, yet
    // its admin owner still shares it with everyone.
    const key = await makeLlmProviderApiKey(org.id, null, { userId: admin.id });
    const context = {
      organizationId: org.id,
      userId: admin.id,
      resource: "llmProviderApiKey" as const,
      scope: key.id,
    };
    const current = await policyOf(context);
    await save({
      ...context,
      grants: [
        ...(current?.grants ?? []),
        { subject: EVERYONE, actions: ["read", "use"] },
      ],
    });
    expect((await policyOf(context))?.grants).toContainEqual({
      subject: EVERYONE,
      actions: ["read", "use"],
    });
  });

  test("an editor may for models and credentials, which they manage everywhere, but not for agents", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const editor = await makeUser();
    await makeMember(editor.id, org.id, { role: "editor" });
    const may = (resource: ScopedResource) =>
      ResourcePermissions.canShareOrganizationWide({
        organizationId: org.id,
        userId: editor.id,
        resource,
      });
    expect(await may("credential")).toBe(true);
    expect(await may("llmModel")).toBe(true);
    expect(await may("agent")).toBe(false);
    await expect(
      ResourcePermissions.validateInitialGrants({
        organizationId: org.id,
        userId: editor.id,
        resource: "agent",
        grants: [{ subject: MEMBER_ROLE, actions: ["read", "use"] }],
        target: { id: crypto.randomUUID(), name: "New", authorId: editor.id },
      }),
    ).rejects.toThrow(
      "Only someone with Full access to every agent can share it with everyone in the organization or with a role.",
    );
  });

  test("a custom role that edits access policies may, without any `*` grant", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { agent: ["read", "create"], accessPolicies: ["update"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    await expect(
      ResourcePermissions.validateInitialGrants({
        organizationId: org.id,
        userId: user.id,
        resource: "agent",
        grants: [{ subject: EVERYONE, actions: ["read", "use"] }],
        target: { id: crypto.randomUUID(), name: "New", authorId: user.id },
      }),
    ).resolves.toBeUndefined();
  });

  test("a chat's owner shares it with everyone as before", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id);
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await ConversationModel.create({
      organizationId: org.id,
      userId: member.id,
      agentId: agent.id,
    });
    const context = {
      organizationId: org.id,
      userId: member.id,
      resource: "conversation" as const,
      scope: conversation.id,
    };
    const grants: ResourcePermissionGrant[] = [
      {
        subject: { type: "user", id: member.id },
        actions: ["read", "manage-permissions"],
      },
      { subject: EVERYONE, actions: ["read"] },
    ];
    await save({ ...context, grants });
    expect((await policyOf(context))?.grants).toEqual(grants);
    expect(
      (
        await ResourcePermissions.searchSubjects({ ...context, query: "" })
      ).some((recipient) => recipient.subject.type === "organization"),
    ).toBe(true);
  });

  test("the recipient pickers offer everyone and the roles only to those who may add them", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeServiceAccount,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id);
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const platform = await makeTeam(org.id, member.id, { name: "Platform" });
    await makeTeamMember(platform.id, member.id);
    await makeTeam(org.id, admin.id, { name: "Finance" });
    await makeServiceAccount(org.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      access: "personal",
    });
    const context = {
      organizationId: org.id,
      resource: "mcpRegistry" as const,
      scope: catalog.id,
    };
    await seedPolicy({
      ...context,
      grants: [{ subject: { type: "user", id: member.id }, actions: FULL }],
    });
    const typesFor = async (userId: string) =>
      new Set(
        (
          await ResourcePermissions.searchSubjects({
            ...context,
            userId,
            query: "",
          })
        ).map((recipient) => recipient.subject.type),
      );
    const memberTypes = await typesFor(member.id);
    expect(memberTypes.has("organization")).toBe(false);
    expect(memberTypes.has("role")).toBe(false);
    expect(memberTypes.has("serviceAccount")).toBe(false);
    expect(memberTypes.has("team")).toBe(true);
    expect(memberTypes.has("user")).toBe(true);
    const adminTypes = await typesFor(admin.id);
    expect(adminTypes.has("organization")).toBe(true);
    expect(adminTypes.has("role")).toBe(true);
    expect(adminTypes.has("serviceAccount")).toBe(true);

    // A member's picker holds their own teams, and leaves out the admin, whose
    // role already has Full access to every entry.
    const memberNames = (
      await ResourcePermissions.searchSubjects({
        ...context,
        userId: member.id,
        query: "",
      })
    ).flatMap((recipient) =>
      recipient.subject.type === "team" || recipient.subject.type === "user"
        ? [recipient.subject.id]
        : [],
    );
    expect(memberNames).toContain(platform.id);
    expect(memberNames).toContain(member.id);
    expect(memberNames).not.toContain(admin.id);
    expect(
      (
        await ResourcePermissions.searchSubjects({
          ...context,
          userId: member.id,
          query: "Finance",
        })
      ).length,
    ).toBe(0);

    const initialTypes = async (userId: string) =>
      (
        await ResourcePermissions.searchInitialSubjects({
          organizationId: org.id,
          userId,
          resource: "agent",
          query: "",
        })
      ).map((recipient) => recipient.subject.type);
    expect(await initialTypes(member.id)).not.toContain("organization");
    expect(await initialTypes(member.id)).not.toContain("role");
    expect(await initialTypes(admin.id)).toContain("organization");
  });

  test("a credential created without named recipients reaches everyone only when its creator may share that widely", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const creator = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { credential: ["read", "create"] },
    });
    await makeMember(creator.id, org.id, { role: role.role });
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const create = (userId: string, key: string) =>
      createRuntimeCredentialDefinition({
        organizationId: org.id,
        userId,
        definition: {
          key,
          name: key,
          kind: "secret",
          description: "",
          icon: null,
          allowPersonal: false,
          allowOrganization: true,
        },
      });
    const grantsOf = async (id: string) =>
      (
        await policyOf({
          organizationId: org.id,
          resource: "credential",
          scope: id,
        })
      )?.grants;

    const limited = await create(creator.id, "team-only-secret");
    expect(await grantsOf(limited.id)).toEqual([
      { subject: { type: "user", id: creator.id }, actions: FULL },
    ]);
    const shared = await create(admin.id, "shared-secret");
    expect(await grantsOf(shared.id)).toEqual(
      expect.arrayContaining(DEFAULT_CREDENTIAL_GRANTS),
    );
    // Naming everyone explicitly is still refused for the limited creator.
    await expect(
      createRuntimeCredentialDefinition({
        organizationId: org.id,
        userId: creator.id,
        definition: {
          key: "explicit-secret",
          name: "explicit-secret",
          kind: "secret",
          description: "",
          icon: null,
          allowPersonal: false,
          allowOrganization: true,
        },
        initialGrants: DEFAULT_CREDENTIAL_GRANTS,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

async function seedPolicy(params: {
  organizationId: string;
  resource: ScopedResource;
  scope: string;
  grants: ResourcePermissionGrant[];
}) {
  const current = await ResourcePermissionPolicyModel.find(params);
  const updated = await ResourcePermissionPolicyModel.replace({
    ...params,
    revision: current?.revision ?? 0,
  });
  expect(updated).not.toBeNull();
}

async function save(params: {
  organizationId: string;
  userId: string;
  resource: ScopedResource;
  scope: string;
  grants: ResourcePermissionGrant[];
}) {
  const current = await ResourcePermissionPolicyModel.find(params);
  return ResourcePermissions.updatePolicy({
    ...params,
    revision: current?.revision ?? 0,
  });
}

function policyOf(params: {
  organizationId: string;
  resource: ScopedResource;
  scope: string;
}) {
  return ResourcePermissionPolicyModel.find(params);
}
