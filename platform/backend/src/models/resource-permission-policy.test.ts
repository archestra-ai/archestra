// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import type {
  PermissionSubject,
  ResourceAccessRelation,
  ResourcePermissionGrant,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { ResourcePermissions } from "@/services/resource-permissions";
import { runScopedResourcePermissionCutover } from "@/services/resource-permissions-cutover";
import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import AgentTeamModel from "./agent-team";
import EnvironmentModel from "./environment";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import OrganizationModel from "./organization";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

describe("resource permission policy persistence", () => {
  test("batch policy lookup accepts more scopes than the PostgreSQL parameter limit", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const first = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "First batch target",
    });
    const last = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Last batch target",
    });
    await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Excluded target",
    });
    const scopes = Array.from(
      { length: 65_536 },
      (_, index) =>
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    );
    scopes[0] = first.id;
    scopes[scopes.length - 1] = last.id;
    const policies = await ResourcePermissionPolicyModel.findApplicableBatch({
      organizationId: organization.id,
      resource: "environment",
      scopes,
    });
    expect(policies.map((policy) => policy.scope).sort()).toEqual(
      ["*", first.id, last.id].sort(),
    );
    const wildcardOnly =
      await ResourcePermissionPolicyModel.findApplicableBatch({
        organizationId: organization.id,
        resource: "environment",
        scopes: [],
      });
    expect(wildcardOnly.map((policy) => policy.scope)).toEqual(["*"]);
  });

  test("a private agent shared with a role stays unavailable to organization credentials", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeCustomRole,
  }) => {
    const organization = await makeOrganization();
    const author = await makeUser();
    const role = await makeCustomRole(organization.id, { permission: {} });
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: author.id,
      agentType: "agent",
      access: "personal",
    });
    const key = {
      organizationId: organization.id,
      resource: "agent" as const,
      scope: agent.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [
        { subject: { type: "role", id: role.id }, actions: ["read", "use"] },
      ],
    });

    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        organizationId: organization.id,
        agentId: agent.id,
        teamId: null,
      }),
    ).toBe(false);

    const rolePolicy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: rolePolicy?.revision ?? 0,
      grants: [
        { subject: { type: "organization", id: "*" }, actions: ["use"] },
      ],
    });
    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        organizationId: organization.id,
        agentId: agent.id,
        teamId: null,
      }),
    ).toBe(true);
  });
  test("a migrated organization-visible agent remains usable by organization credentials", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const organization = await makeOrganization({ legacyPermissions: true });
    const author = await makeUser();
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: author.id,
      agentType: "agent",
    });
    await runScopedResourcePermissionCutover();

    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        organizationId: organization.id,
        agentId: agent.id,
        teamId: null,
      }),
    ).toBe(true);
  });
  test("restricting a migrated public agent to a role revokes organization credential access", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeCustomRole,
  }) => {
    const organization = await makeOrganization({ legacyPermissions: true });
    const author = await makeUser();
    const role = await makeCustomRole(organization.id, { permission: {} });
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: author.id,
      agentType: "agent",
    });
    await runScopedResourcePermissionCutover();
    const key = {
      organizationId: organization.id,
      resource: "agent" as const,
      scope: agent.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [
        { subject: { type: "role", id: role.id }, actions: ["read", "use"] },
      ],
    });
    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        organizationId: organization.id,
        agentId: agent.id,
        teamId: null,
      }),
    ).toBe(false);
    await runScopedResourcePermissionCutover();
    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        organizationId: organization.id,
        agentId: agent.id,
        teamId: null,
      }),
    ).toBe(false);
    const restricted = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: restricted?.revision ?? 0,
      grants: [
        { subject: { type: "organization", id: "*" }, actions: ["use"] },
      ],
    });
    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        organizationId: organization.id,
        agentId: agent.id,
        teamId: null,
      }),
    ).toBe(true);
  });
  test("an explicitly granted role does not publish a newly created org-scope agent", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
  }) => {
    const organization = await makeOrganization();
    const author = await makeUser();
    const role = await makeCustomRole(organization.id, { permission: {} });
    const agent = await AgentModel.create(
      {
        name: "Creator-only org-scope agent",
        organizationId: organization.id,
        agentType: "agent",
        scope: "org",
        teams: [],
        users: [],
        labels: [],
        knowledgeBaseIds: [],
        connectorIds: [],
      },
      author.id,
      { initialPermissionGrants: [] },
    );
    const key = {
      organizationId: organization.id,
      resource: "agent" as const,
      scope: agent.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [
        { subject: { type: "role", id: role.id }, actions: ["read", "use"] },
      ],
    });

    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        organizationId: organization.id,
        agentId: agent.id,
        teamId: null,
      }),
    ).toBe(false);
  });
  test("new organizations initialize scoped role grants without restoring later revocations", async ({
    makeUser,
    makeMember,
  }) => {
    const org = await OrganizationModel.getOrCreateDefaultOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const context = {
      organizationId: org.id,
      userId: admin.id,
      resource: "agent" as const,
      scope: "*",
    };
    expect(
      await ResourcePermissions.allows({ ...context, action: "update" }),
    ).toBe(true);
    const policy = await ResourcePermissionPolicyModel.find(context);
    await ResourcePermissionPolicyModel.replace({
      ...context,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    await OrganizationModel.getOrCreateDefaultOrganization();
    expect(
      await ResourcePermissions.allows({ ...context, action: "update" }),
    ).toBe(false);
  });
  test("permanent deletion removes object grants without removing wildcard access", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeInternalMcpCatalog,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({
      organizationId: organization.id,
      agentType: "agent",
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
    });
    for (const target of [
      { resource: "agent" as const, id: agent.id },
      { resource: "mcpRegistry" as const, id: catalog.id },
    ]) {
      const key = {
        organizationId: organization.id,
        resource: target.resource,
      };
      const grants = [
        {
          subject: { type: "user" as const, id: user.id },
          actions: ["read" as const],
        },
      ];
      await ResourcePermissionPolicyModel.replace({
        ...key,
        scope: target.id,
        revision:
          (
            await ResourcePermissionPolicyModel.find({
              ...key,
              scope: target.id,
            })
          )?.revision ?? 0,
        grants,
      });
      await ResourcePermissionPolicyModel.replace({
        ...key,
        scope: "*",
        revision:
          (await ResourcePermissionPolicyModel.find({ ...key, scope: "*" }))
            ?.revision ?? 0,
        grants,
      });
      if (target.resource === "agent") await AgentModel.hardDelete(target.id);
      else await InternalMcpCatalogModel.hardDelete(target.id);
      expect(
        await ResourcePermissionPolicyModel.find({ ...key, scope: target.id }),
      ).toBeNull();
      expect(
        (await ResourcePermissionPolicyModel.find({ ...key, scope: "*" }))
          ?.grants,
      ).toEqual(grants);
    }
  });

  test("a stale editor cannot restore a revoked grant", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const key = {
      organizationId: organization.id,
      resource: "agent" as const,
      scope: "00000000-0000-4000-8000-000000000001",
    };
    const grants = [
      {
        subject: { type: "user" as const, id: user.id },
        actions: ["read" as const],
      },
    ];
    const initial = await ResourcePermissionPolicyModel.replace({
      ...key,
      grants,
      revision: 0,
    });
    expect(initial?.revision).toBe(1);
    expect(
      await ResourcePermissionPolicyModel.replace({
        ...key,
        grants,
        revision: 0,
      }),
    ).toBeNull();
    const revoked = await ResourcePermissionPolicyModel.replace({
      ...key,
      grants: [],
      revision: 1,
    });
    expect(revoked?.revision).toBe(2);
    expect(
      await ResourcePermissionPolicyModel.replace({
        ...key,
        grants,
        revision: 1,
      }),
    ).toBeNull();
    expect((await ResourcePermissionPolicyModel.find(key))?.grants).toEqual([]);
  });

  test("applicable policies include only the object and wildcard within the organization", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const foreignOrganization = await makeOrganization();
    const key = {
      organizationId: organization.id,
      resource: "agent" as const,
      scope: "00000000-0000-4000-8000-000000000001",
    };
    for (const policy of [
      key,
      { ...key, scope: "*" as const },
      { ...key, scope: "teams:*" },
      { ...key, organizationId: foreignOrganization.id },
      { ...key, resource: "skill" as const },
      { ...key, scope: "00000000-0000-4000-8000-000000000002" },
    ]) {
      await ResourcePermissionPolicyModel.replace({
        ...policy,
        revision: 0,
        grants: [],
      });
    }
    const policies = await ResourcePermissionPolicyModel.findApplicable(key);
    expect(policies.map((policy) => policy.scope).sort()).toEqual(
      ["*", key.scope].sort(),
    );
    expect(
      policies.every(
        (policy) =>
          policy.organizationId === organization.id &&
          policy.resource === "agent",
      ),
    ).toBe(true);
  });
});

describe("accessRelationCondition sharedWith and ownerIds", () => {
  test("narrows by the subjects an object's own policy grants read to, by owner, and ANDs them with relations", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeTeam,
    makeCustomRole,
    makeServiceAccount,
  }) => {
    const organization = await makeOrganization();
    const caller = await makeUser();
    const other = await makeUser();
    const named = await makeUser();
    const team = await makeTeam(organization.id, caller.id);
    const otherTeam = await makeTeam(organization.id, caller.id);
    const role = await makeCustomRole(organization.id, { permission: {} });
    const serviceAccount = await makeServiceAccount(organization.id);

    const agentWith = async (params: {
      name: string;
      authorId: string;
      grants: ResourcePermissionGrant[];
    }) => {
      const agent = await makeAgent({
        name: params.name,
        organizationId: organization.id,
        authorId: params.authorId,
        agentType: "agent",
        access: "personal",
      });
      const key = {
        organizationId: organization.id,
        resource: "agent" as const,
        scope: agent.id,
      };
      const policy = await ResourcePermissionPolicyModel.find(key);
      await ResourcePermissionPolicyModel.replace({
        ...key,
        revision: policy?.revision ?? 0,
        grants: [
          {
            subject: { type: "user", id: params.authorId },
            actions: ["read", "use", "update", "delete", "manage-permissions"],
          },
          ...params.grants,
        ],
      });
      return agent;
    };
    await agentWith({ name: "Private", authorId: caller.id, grants: [] });
    await agentWith({
      name: "Team",
      authorId: caller.id,
      grants: [{ subject: { type: "team", id: team.id }, actions: ["read"] }],
    });
    await agentWith({
      name: "Other team",
      authorId: other.id,
      grants: [
        { subject: { type: "team", id: otherTeam.id }, actions: ["read"] },
      ],
    });
    await agentWith({
      name: "Role",
      authorId: other.id,
      grants: [{ subject: { type: "role", id: role.id }, actions: ["read"] }],
    });
    await agentWith({
      name: "Org",
      authorId: other.id,
      grants: [
        { subject: { type: "organization", id: "*" }, actions: ["read"] },
      ],
    });
    await agentWith({
      name: "Named user",
      authorId: other.id,
      grants: [{ subject: { type: "user", id: named.id }, actions: ["read"] }],
    });
    await agentWith({
      name: "Service account",
      authorId: caller.id,
      grants: [
        {
          subject: { type: "serviceAccount", id: serviceAccount.id },
          actions: ["read"],
        },
      ],
    });

    const list = async (filter: {
      relations?: ResourceAccessRelation[];
      sharedWith?: PermissionSubject[];
      ownerIds?: string[];
    }) => {
      const table = schema.agentsTable;
      const condition = ResourcePermissionPolicyModel.accessRelationCondition({
        organizationId: table.organizationId,
        resource: "agent",
        scopeColumn: table.id,
        ownerColumn: table.authorId,
        userId: caller.id,
        subjects: [{ type: "user", id: caller.id }],
        ...filter,
      });
      const rows = await db
        .select({ name: table.name })
        .from(table)
        .where(and(eq(table.organizationId, organization.id), condition));
      return rows.map((row) => row.name).sort();
    };

    expect(
      ResourcePermissionPolicyModel.accessRelationCondition({
        organizationId: organization.id,
        resource: "agent",
        scopeColumn: schema.agentsTable.id,
        ownerColumn: schema.agentsTable.authorId,
        userId: caller.id,
        subjects: [],
      }),
    ).toBeUndefined();
    expect(await list({ sharedWith: [{ type: "team", id: team.id }] })).toEqual(
      ["Team"],
    );
    expect(
      await list({
        sharedWith: [
          { type: "team", id: team.id },
          { type: "team", id: otherTeam.id },
        ],
      }),
    ).toEqual(["Other team", "Team"]);
    // Literal: a role grant is not a grant to everyone, and vice versa.
    expect(await list({ sharedWith: [{ type: "role", id: role.id }] })).toEqual(
      ["Role"],
    );
    expect(
      await list({ sharedWith: [{ type: "organization", id: "*" }] }),
    ).toEqual(["Org"]);
    expect(
      await list({ sharedWith: [{ type: "user", id: named.id }] }),
    ).toEqual(["Named user"]);
    expect(
      await list({
        sharedWith: [{ type: "serviceAccount", id: serviceAccount.id }],
      }),
    ).toEqual(["Service account"]);
    expect(await list({ ownerIds: [other.id] })).toEqual([
      "Named user",
      "Org",
      "Other team",
      "Role",
    ]);
    expect(
      await list({
        ownerIds: [caller.id],
        sharedWith: [
          { type: "team", id: team.id },
          { type: "team", id: otherTeam.id },
        ],
      }),
    ).toEqual(["Team"]);
    // `org` relation counts role grants too; sharedWith then narrows.
    expect(await list({ relations: ["org"] })).toEqual(["Org", "Role"]);
    expect(
      await list({
        relations: ["org"],
        sharedWith: [{ type: "role", id: role.id }],
      }),
    ).toEqual(["Role"]);
    expect(await list({ relations: ["mine"], ownerIds: [other.id] })).toEqual(
      [],
    );
  });
});
