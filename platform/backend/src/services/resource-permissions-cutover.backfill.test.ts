// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import AgentTeamModel from "@/models/agent-team";
import AgentUserModel from "@/models/agent-user";
import AppAccessModel from "@/models/app-access";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import ModelModel from "@/models/model";
import ModelTeamModel from "@/models/model-team";
import ModelUserModel from "@/models/model-user";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ServiceAccountModel from "@/models/service-account";
import SkillModel from "@/models/skill";
import SkillTeamModel from "@/models/skill-team";
import SkillUserModel from "@/models/skill-user";
import TeamModel from "@/models/team";
import { checkModelTeamAccess } from "@/routes/proxy/utils/model-team-access";
import { ResourcePermissions } from "@/services/resource-permissions";
import { describe, expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

describe("resource sharing grant backfill", () => {
  test("a missing object policy never reactivates legacy visibility after organization migration", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      scope: "org",
    });
    await runMigration();
    const access = { agentId: agent.id, userId: user.id, isAgentAdmin: false };
    expect(await AgentTeamModel.userHasAgentAccess(access)).toBe(true);
    await db.transaction(async (tx) =>
      ResourcePermissionPolicyModel.deleteForTarget({
        tx,
        resources: ["agent"],
        scope: agent.id,
      }),
    );
    expect(await AgentTeamModel.userHasAgentAccess(access)).toBe(false);
    expect(
      await AgentTeamModel.getUserAccessibleAgentIds(user.id, false),
    ).not.toContain(agent.id);
    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        organizationId: org.id,
        agentId: agent.id,
        teamId: null,
      }),
    ).toBe(false);
  });

  test("organization skill publication follows use grants and immediate revocation", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        authorId: owner.id,
        name: "publication-grants",
        description: "Publication test",
        content: "# Instructions",
        metadata: {},
        sourceType: "manual",
        scope: "personal",
      },
      files: [],
    });
    if (!skill) throw new Error("Skill fixture creation failed");
    await runMigration();
    const key = {
      organizationId: org.id,
      resource: "skill" as const,
      scope: skill.id,
    };
    const publication = {
      organizationId: org.id,
      environmentId: null,
      excludedForAgentId: gateway.id,
      limit: 20,
    };
    expect(await SkillModel.findOrgScopedInEnvironment(publication)).toEqual(
      [],
    );
    const initial = await ResourcePermissionPolicyModel.find(key);
    const granted = await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: initial?.revision ?? 0,
      grants: [
        {
          subject: { type: "organization", id: "*" },
          actions: ["read", "use"],
        },
      ],
    });
    expect(granted).not.toBeNull();
    expect(
      (await SkillModel.findOrgScopedInEnvironment(publication)).map(
        (row) => row.id,
      ),
    ).toEqual([skill.id]);
    expect(
      await SkillTeamModel.userHasSkillAccess({
        organizationId: org.id,
        skill,
        action: "use",
      }),
    ).toBe(true);
    const revoked = await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: granted?.revision ?? 0,
      grants: [],
    });
    expect(revoked).not.toBeNull();
    expect(await SkillModel.findOrgScopedInEnvironment(publication)).toEqual(
      [],
    );
    expect(
      await SkillTeamModel.userHasSkillAccess({
        organizationId: org.id,
        skill,
        action: "use",
      }),
    ).toBe(false);
  });

  test("shared credentials follow migrated use grants and cannot bypass revocation", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeAgent,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    await makeMember(owner.id, org.id);
    const team = await makeTeam(org.id, owner.id);
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      scope: "org",
      authorId: owner.id,
    });
    await runMigration();
    const key = {
      organizationId: org.id,
      resource: "mcpGateway" as const,
      scope: gateway.id,
    };
    const credential = { organizationId: org.id, agentId: gateway.id };
    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        ...credential,
        teamId: null,
      }),
    ).toBe(true);
    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        ...credential,
        teamId: team.id,
      }),
    ).toBe(true);
    const policy = await ResourcePermissionPolicyModel.find(key);
    const restricted = await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [{ subject: { type: "team", id: team.id }, actions: ["read"] }],
    });
    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        ...credential,
        teamId: null,
      }),
    ).toBe(false);
    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        ...credential,
        teamId: team.id,
      }),
    ).toBe(false);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: restricted.revision,
      grants: [{ subject: { type: "team", id: team.id }, actions: ["use"] }],
    });
    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        ...credential,
        teamId: team.id,
      }),
    ).toBe(true);
    expect(
      await AgentTeamModel.credentialHasAgentAccess({
        ...credential,
        teamId: null,
      }),
    ).toBe(false);
  });

  test("the complete migration converts sharing and rolls back grants on transaction failure", async ({
    makeOrganization,
    makeAgent,
    removeObjectPolicies,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      scope: "org",
    });
    await removeObjectPolicies(org.id);
    const key = {
      organizationId: org.id,
      resource: "agent" as const,
      scope: agent.id,
    };
    const before = await ResourcePermissionPolicyModel.find(key);
    const failure = new Error("Simulated failure after backfill");
    await expect(
      db.transaction(async (tx) => {
        // Joins the caller's transaction so the failure below rolls the whole
        // conversion back, which is what a crashed start must leave behind.
        await runScopedResourcePermissionCutover(tx);
        const migrated = await tx.execute(sql`
          SELECT grants, legacy_sharing_migrated FROM resource_permission_policies
          WHERE organization_id = ${org.id} AND resource = 'agent' AND scope = ${agent.id}
        `);
        // Organization visibility lands on the roles that hold `agent:read`,
        // and `use` stays organization-wide because chatting never asked for
        // that read. Every stored grant is widened to the nearest preset, so
        // the organization's `use` becomes the `use` preset [read, use]: a
        // role without `agent:read` now lists the agent too. That widening is
        // deliberate.
        expect(migrated.rows).toEqual([
          {
            grants: [
              {
                subject: { type: "organization", id: "*" },
                actions: ["read", "use"],
              },
              ...["admin", "editor", "member", "platform_admin"].map((id) => ({
                subject: { type: "role", id },
                actions: ["read", "use"],
              })),
            ],
            legacy_sharing_migrated: true,
          },
        ]);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(before);
    expect(
      await ResourcePermissionPolicyModel.find({ ...key, scope: "*" }),
    ).toBeNull();
  });

  test("gateway migration preserves named access through deletion and restoration without importing foreign recipients", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    removeObjectPolicies,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const foreign = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    const reader = await makeUser();
    const writer = await makeUser();
    const outsider = await makeUser();
    for (const user of [owner, reader, writer])
      await makeMember(user.id, org.id);
    await makeMember(outsider.id, foreign.id);
    const gateway = await makeAgent({
      organizationId: org.id,
      authorId: owner.id,
      agentType: "mcp_gateway",
      scope: "personal",
    });
    await AgentUserModel.syncAgentUsers(gateway.id, [
      { id: reader.id, level: "use" },
      { id: writer.id, level: "write" },
      { id: outsider.id, level: "write" },
    ]);
    await removeObjectPolicies(org.id);
    await AgentModel.delete(gateway.id);
    await runMigration();
    const key = {
      organizationId: org.id,
      resource: "mcpGateway" as const,
      scope: gateway.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    expect(policy?.legacySharingMigrated).toBe(true);
    expect(policy?.grants).toHaveLength(3);
    expect(policy?.grants).toEqual(
      expect.arrayContaining([
        {
          subject: { type: "user", id: owner.id },
          actions: ["delete", "manage-permissions", "read", "update", "use"],
        },
        { subject: { type: "user", id: reader.id }, actions: ["read", "use"] },
        {
          subject: { type: "user", id: writer.id },
          actions: ["read", "update", "use"],
        },
      ]),
    );
    expect(
      await ResourcePermissionPolicyModel.find({ ...key, resource: "agent" }),
    ).toBeNull();
    await AgentModel.restore(gateway.id);
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(policy);
    await runMigration();
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(policy);
  });

  test("organization access stays read/use and foreign-only team sharing becomes an authoritative empty policy", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeAgent,
    removeObjectPolicies,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const foreign = await makeOrganization({ legacyPermissions: true });
    const outsider = await makeUser();
    await makeMember(outsider.id, foreign.id);
    const team = await makeTeam(foreign.id, outsider.id);
    const publicAgent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      scope: "org",
    });
    const restricted = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      scope: "team",
    });
    await AgentTeamModel.syncAgentTeams(restricted.id, [team.id]);
    await removeObjectPolicies(org.id);
    await removeObjectPolicies(foreign.id);
    await runMigration();
    const publicPolicy = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource: "agent",
      scope: publicAgent.id,
    });
    // Finding the agent goes to the roles that hold `agent:read`. Chatting
    // with it never consulted the caller's role, so `use` stays with the
    // organization at large — a role shaped for chat alone would otherwise
    // lose the agent on upgrade. Every stored grant is widened to the nearest
    // preset, so that `use` becomes the `use` preset [read, use] and every
    // member can now list the agent. That widening is deliberate.
    expect(publicPolicy?.grants).toEqual([
      {
        subject: { type: "organization", id: "*" },
        actions: ["read", "use"],
      },
      ...["admin", "editor", "member", "platform_admin"].map((id) => ({
        subject: { type: "role", id },
        actions: ["read", "use"],
      })),
    ]);
    const restrictedPolicy = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource: "mcpGateway",
      scope: restricted.id,
    });
    expect(restrictedPolicy).toMatchObject({
      legacySharingMigrated: true,
      grants: [],
    });
  });

  test("new provider models receive grants and refresh never restores revoked invocation", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const user = await makeUser();
    await makeMember(user.id, org.id);
    await runMigration();
    const data: Parameters<typeof ModelModel.create>[0] = {
      externalId: "scoped-provider-model",
      provider: "openai" as const,
      modelId: "scoped-provider-model",
      description: "Provider model",
      contextLength: 1000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: false,
      promptPricePerToken: "0.000001",
      completionPricePerToken: "0.000002",
      lastSyncedAt: new Date(),
    };
    const model = await ModelModel.create(data);
    const key = {
      organizationId: org.id,
      resource: "llmModel" as const,
      scope: model.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    expect(policy?.legacySharingMigrated).toBe(true);
    const context = {
      organizationId: org.id,
      authenticatedUserId: user.id,
      modelId: data.modelId,
      provider: data.provider,
    };
    expect(await checkModelTeamAccess(context)).toEqual({ allowed: true });
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    await ModelModel.upsert(data);
    await ModelModel.bulkUpsert([data]);
    expect((await ResourcePermissionPolicyModel.find(key))?.grants).toEqual([]);
    expect(await checkModelTeamAccess(context)).toMatchObject({
      allowed: false,
    });
  });
  test("resources created after migration receive authoritative policies without an initialGrants payload", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
    makeApp,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    const role = await makeCustomRole(org.id, { permission: {} });
    await makeMember(owner.id, org.id, { role: role.role });
    await runMigration();
    const ownership = {
      organizationId: org.id,
      authorId: owner.id,
      scope: "personal" as const,
    };
    const agent = await makeAgent({ ...ownership, agentType: "agent" });
    const catalog = await makeInternalMcpCatalog(ownership);
    const app = await makeApp(ownership);
    const skill = await SkillModel.createWithFiles({
      skill: {
        ...ownership,
        name: "new-after-migration",
        description: "New skill",
        content: "# Skill",
        metadata: {},
        sourceType: "manual",
      },
      files: [],
    });
    if (!skill) throw new Error("Skill fixture creation failed");
    for (const target of [
      { resource: "agent", scope: agent.id },
      { resource: "mcpRegistry", scope: catalog.id },
      { resource: "app", scope: app.id },
      { resource: "skill", scope: skill.id },
    ] as const) {
      const key = { organizationId: org.id, ...target };
      const policy = await ResourcePermissionPolicyModel.find(key);
      expect(policy?.legacySharingMigrated).toBe(true);
      await expect(
        ResourcePermissions.require({
          ...key,
          userId: owner.id,
          action: "update",
        }),
      ).resolves.toBeUndefined();
      await ResourcePermissionPolicyModel.replace({
        ...key,
        revision: policy?.revision ?? 0,
        grants: [],
      });
      await expect(
        ResourcePermissions.require({
          ...key,
          userId: owner.id,
          action: "update",
        }),
      ).rejects.toThrow("permission");
    }
  });
  test("a migrated disabled app remains visible to its author until their grant is revoked", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeApp,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    const other = await makeUser();
    await makeMember(owner.id, org.id);
    await makeMember(other.id, org.id);
    const app = await makeApp({
      organizationId: org.id,
      authorId: owner.id,
      scope: "personal",
      enabled: false,
    });
    await runMigration();
    const context = { organizationId: org.id, userId: owner.id };
    expect(await AppAccessModel.getUserAccessibleAppIds(context)).toContain(
      app.id,
    );
    expect(
      await AppAccessModel.getUserAccessibleAppIds({
        ...context,
        userId: other.id,
        isAppAdmin: true,
      }),
    ).not.toContain(app.id);
    const key = {
      organizationId: org.id,
      resource: "app" as const,
      scope: app.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    expect(await AppAccessModel.getUserAccessibleAppIds(context)).not.toContain(
      app.id,
    );
  });
  test("legacy team-admin authority becomes a direct user grant without mixing role scopes", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeTeam,
    makeTeamMember,
    makeAgent,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const user = await makeUser();
    const owner = await makeUser();
    const reader = await makeCustomRole(org.id, {
      permission: { agent: ["read", "admin"] },
    });
    const editor = await makeCustomRole(org.id, {
      permission: { agent: ["update", "team-admin"] },
    });
    await makeMember(user.id, org.id, {
      role: `${reader.role},${editor.role}`,
    });
    const team = await makeTeam(org.id, owner.id);
    await makeTeamMember(team.id, user.id, { role: "member" });
    const shared = await makeAgent({
      organizationId: org.id,
      authorId: owner.id,
      agentType: "agent",
      scope: "team",
      teams: [team.id],
    });
    const other = await makeAgent({
      organizationId: org.id,
      authorId: owner.id,
      agentType: "agent",
      scope: "personal",
    });
    await runMigration();
    const context = {
      organizationId: org.id,
      userId: user.id,
      resource: "agent" as const,
    };
    await expect(
      ResourcePermissions.require({
        ...context,
        scope: shared.id,
        action: "update",
      }),
    ).resolves.toBeUndefined();
    await expect(
      ResourcePermissions.require({
        ...context,
        scope: other.id,
        action: "read",
      }),
    ).resolves.toBeUndefined();
    await expect(
      ResourcePermissions.require({
        ...context,
        scope: other.id,
        action: "update",
      }),
    ).rejects.toThrow("permission");
    await TeamModel.removeMember(team.id, user.id);
    await expect(
      ResourcePermissions.require({
        ...context,
        scope: shared.id,
        action: "update",
      }),
    ).resolves.toBeUndefined();
    await expect(
      ResourcePermissions.require({
        ...context,
        scope: shared.id,
        action: "read",
      }),
    ).resolves.toBeUndefined();
  });
  test("revocation after migration overrides personal ownership in reads, lists, and runtime access", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
    makeApp,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    const role = await makeCustomRole(org.id, { permission: {} });
    await makeMember(owner.id, org.id, { role: role.role });
    const context = { organizationId: org.id, userId: owner.id };
    const ownership = {
      organizationId: org.id,
      authorId: owner.id,
      scope: "personal" as const,
    };
    const agent = await makeAgent({ ...ownership, agentType: "agent" });
    const catalog = await makeInternalMcpCatalog(ownership);
    const app = await makeApp({ ...ownership, enabled: true });
    const skill = await SkillModel.createWithFiles({
      skill: {
        ...ownership,
        name: "migrated-skill",
        description: "Migration test",
        content: "# Skill",
        metadata: {},
        sourceType: "manual",
      },
      files: [],
    });
    if (!skill) throw new Error("Skill fixture creation failed");
    await runMigration();
    for (const target of [
      { resource: "agent", scope: agent.id },
      { resource: "mcpRegistry", scope: catalog.id },
      { resource: "app", scope: app.id },
      { resource: "skill", scope: skill.id },
    ] as const) {
      const key = { ...context, ...target };
      await expect(
        ResourcePermissions.require({ ...key, action: "use" }),
      ).resolves.toBeUndefined();
      const policy = await ResourcePermissionPolicyModel.find(key);
      expect(policy?.legacySharingMigrated).toBe(true);
      await ResourcePermissionPolicyModel.replace({
        ...key,
        revision: policy?.revision ?? 0,
        grants: [],
      });
      await expect(
        ResourcePermissions.require({ ...key, action: "use" }),
      ).rejects.toThrow("permission");
    }
    expect(
      await AgentTeamModel.userHasAgentAccess({
        userId: owner.id,
        agentId: agent.id,
        isAgentAdmin: false,
        action: "use",
      }),
    ).toBe(false);
    expect(
      (await AgentModel.findAll(owner.id, false)).map((row) => row.id),
    ).not.toContain(agent.id);
    expect(
      await McpCatalogTeamModel.userHasCatalogAccess({
        ...context,
        catalogId: catalog.id,
      }),
    ).toBe(false);
    expect(
      await InternalMcpCatalogModel.findAll({ ...context, isAdmin: false }),
    ).toEqual([]);
    expect(
      await SkillTeamModel.userHasSkillAccess({
        ...context,
        skill,
        action: "use",
      }),
    ).toBe(false);
    expect(await SkillTeamModel.getUserAccessibleSkillIds(context)).toEqual([]);
    expect(
      await AppAccessModel.userHasAppAccess({
        ...context,
        app,
        action: "use",
      }),
    ).toBe(false);
    expect(
      await AppAccessModel.getUserAccessibleAppIds({
        ...context,
        isAppAdmin: false,
      }),
    ).toEqual([]);
  });
  test("use and write teams stay distinct, all members receive the grant, and existing service-account grants survive replay", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeTeam,
    makeTeamMember,
    makeInternalMcpCatalog,
    removeObjectPolicies,
  }) => {
    const organization = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    const viewer = await makeUser();
    const editor = await makeUser();
    const role = await makeCustomRole(organization.id, { permission: {} });
    for (const user of [owner, viewer, editor])
      await makeMember(user.id, organization.id, { role: role.role });
    const readers = await makeTeam(organization.id, owner.id);
    const writers = await makeTeam(organization.id, owner.id);
    await makeTeamMember(readers.id, viewer.id, { role: "admin" });
    await makeTeamMember(writers.id, editor.id, { role: "member" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      authorId: owner.id,
      scope: "team",
      teams: [
        { id: readers.id, level: "use" },
        { id: writers.id, level: "write" },
      ],
    });
    const account = await ServiceAccountModel.create({
      organizationId: organization.id,
      name: "Migration automation",
      role: role.role,
      createdBy: owner.id,
    });
    const key = {
      organizationId: organization.id,
      resource: "mcpRegistry" as const,
      scope: catalog.id,
    };
    await removeObjectPolicies(organization.id);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: 0,
      grants: [
        {
          subject: { type: "serviceAccount", id: account.id },
          actions: ["use"],
        },
      ],
    });
    await runMigration();
    const migrated = await ResourcePermissionPolicyModel.find(key);
    expect(migrated?.grants).toEqual(
      expect.arrayContaining([
        { subject: { type: "team", id: readers.id }, actions: ["read", "use"] },
        {
          subject: { type: "team", id: writers.id },
          actions: ["read", "update", "use"],
        },
        // The pre-existing `use` grant survives, widened to the `use` preset.
        {
          subject: { type: "serviceAccount", id: account.id },
          actions: ["read", "use"],
        },
      ]),
    );
    const editorGrants = await ResourcePermissions.resolve({
      ...key,
      userId: editor.id,
    });
    expect(editorGrants.map((grant) => grant.action)).toContain("update");
    expect(
      (await ResourcePermissions.resolve({ ...key, userId: viewer.id })).map(
        (grant) => grant.action,
      ),
    ).not.toContain("update");
    await runMigration();
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(migrated);
  });

  test("model team restrictions stay in their organization and named model sharing remains read-only", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const organization = await makeOrganization({ legacyPermissions: true });
    const foreign = await makeOrganization({ legacyPermissions: true });
    const user = await makeUser();
    await makeMember(user.id, organization.id);
    const team = await makeTeam(organization.id, user.id);
    const model = await ModelModel.create({
      externalId: "migration-model",
      provider: "openai",
      modelId: "migration-model",
      description: "Migration test model",
      contextLength: 1000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: false,
      promptPricePerToken: "0.000001",
      completionPricePerToken: "0.000002",
      ignored: false,
      lastSyncedAt: new Date(),
    });
    await ModelTeamModel.syncModelTeams(model.id, [team.id]);
    await ModelUserModel.syncModelUsers(model.id, [user.id]);
    await runMigration();
    const key = { resource: "llmModel" as const, scope: model.id };
    expect(
      (
        await ResourcePermissionPolicyModel.find({
          ...key,
          organizationId: organization.id,
        })
      )?.grants,
    ).toEqual(
      expect.arrayContaining([
        { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
        { subject: { type: "user", id: user.id }, actions: ["read"] },
      ]),
    );
    expect(
      (
        await ResourcePermissionPolicyModel.find({
          ...key,
          organizationId: foreign.id,
        })
      )?.grants,
    ).toEqual([]);
    const local = { ...key, organizationId: organization.id };
    const policy = await ResourcePermissionPolicyModel.find(local);
    await ResourcePermissionPolicyModel.replace({
      ...local,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    expect(
      await ModelTeamModel.filterAllowedModelIds({
        modelIds: [model.id],
        organizationId: organization.id,
        userId: user.id,
        action: "use",
      }),
    ).toEqual(new Set());
    expect(
      await checkModelTeamAccess({
        provider: "openai",
        modelId: model.modelId,
        organizationId: organization.id,
        authenticatedUserId: user.id,
      }),
    ).toMatchObject({ allowed: false });
  });

  test("a role holding neither agent nor model read keeps the agent and models it could always use, and now lists the agent", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
    removeObjectPolicies,
  }) => {
    // Chatting and invoking a model asked only whether the object was open to
    // the organization, never what the caller's role could read. A role built
    // for chat alone is the shape that proves the two halves stayed apart.
    const org = await makeOrganization({ legacyPermissions: true });
    const role = await makeCustomRole(org.id, {
      permission: { chat: ["read", "create"] },
    });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: role.role });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      scope: "org",
    });
    const model = await ModelModel.create({
      externalId: "openai/open-model",
      provider: "openai",
      modelId: "open-model",
      inputModalities: ["text"],
      outputModalities: ["text"],
      lastSyncedAt: new Date(),
    });
    await removeObjectPolicies(org.id);
    await runMigration();

    const context = { organizationId: org.id, userId: user.id };
    expect(
      await ResourcePermissions.allows({
        ...context,
        resource: "agent",
        scope: agent.id,
        action: "use",
      }),
    ).toBe(true);
    expect(
      await checkModelTeamAccess({
        provider: "openai",
        modelId: model.modelId,
        organizationId: org.id,
        authenticatedUserId: user.id,
      }),
    ).toEqual({ allowed: true });
    // The organization's `use` grant is widened to the `use` preset
    // [read, use], so this role now lists the agent it never saw before the
    // upgrade. That widening to the nearest preset is deliberate.
    expect(
      await ResourcePermissions.allows({
        ...context,
        resource: "agent",
        scope: agent.id,
        action: "read",
      }),
    ).toBe(true);
  });
  test("an app whose backing MCP server row is gone never receives a policy", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeApp,
    removeObjectPolicies,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    await makeMember(owner.id, org.id);
    const app = await makeApp({
      organizationId: org.id,
      authorId: owner.id,
      scope: "personal",
      enabled: true,
    });
    const intact = await makeApp({
      organizationId: org.id,
      authorId: owner.id,
      scope: "personal",
      enabled: true,
    });
    const [row] = await db
      .select({ mcpServerId: schema.appsTable.mcpServerId })
      .from(schema.appsTable)
      .where(eq(schema.appsTable.id, app.id));
    if (!row.mcpServerId) throw new Error("App fixture has no backing server");
    // `ON DELETE set null` on the app, so the app row survives the removal.
    await db
      .delete(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, row.mcpServerId));
    await removeObjectPolicies(org.id);

    await expect(runMigration()).resolves.toBeUndefined();

    const key = {
      organizationId: org.id,
      resource: "app" as const,
      scope: app.id,
    };
    // DEFECT: the app candidate joins `mcp_server` and `internal_mcp_catalog`
    // with inner joins (cutover.ts:82-85), so an app that has lost its backing
    // server is dropped from the conversion entirely. It gets no policy and no
    // migrated marker, which means it is re-considered on every single boot
    // and never becomes governed by grants.
    expect(await ResourcePermissionPolicyModel.find(key)).toBeNull();
    expect(
      await ResourcePermissionPolicyModel.find({ ...key, scope: intact.id }),
    ).not.toBeNull();
    await expect(runMigration()).resolves.toBeUndefined();
    expect(await ResourcePermissionPolicyModel.find(key)).toBeNull();
  });

  test("a team-scoped agent keeps the individuals it was also shared with", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeAgent,
    removeObjectPolicies,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    const named = await makeUser();
    for (const user of [owner, named]) await makeMember(user.id, org.id);
    const team = await makeTeam(org.id, owner.id);
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: owner.id,
      agentType: "agent",
      scope: "team",
      teams: [team.id],
    });
    await AgentUserModel.syncAgentUsers(agent.id, [
      { id: named.id, level: "write" },
    ]);
    await removeObjectPolicies(org.id);

    await runMigration();

    const policy = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource: "agent",
      scope: agent.id,
    });
    // An object carrying both kinds of sharing keeps both: the named-user
    // branch converts whenever the junction names someone, not only when the
    // scope column says personal. Before, the named individual lost the agent.
    expect(policy?.grants).toEqual([
      { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
      {
        subject: { type: "user", id: named.id },
        actions: ["read", "update", "use"],
      },
    ]);
    expect(
      await ResourcePermissions.allows({
        organizationId: org.id,
        userId: named.id,
        resource: "agent",
        scope: agent.id,
        action: "update",
      }),
    ).toBe(true);
  });

  test("a skill shared with a named writer converts to read, update and use", async ({
    makeOrganization,
    makeUser,
    makeMember,
    removeObjectPolicies,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    const writer = await makeUser();
    for (const user of [owner, writer]) await makeMember(user.id, org.id);
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        authorId: owner.id,
        name: `named-writer-${crypto.randomUUID().slice(0, 8)}`,
        description: "Named write sharing",
        content: "# Instructions",
        metadata: {},
        sourceType: "manual",
        scope: "personal",
      },
      files: [],
    });
    if (!skill) throw new Error("Skill fixture creation failed");
    await SkillUserModel.syncSkillUsers(skill.id, [
      { id: writer.id, level: "write" },
    ]);
    await removeObjectPolicies(org.id);

    await runMigration();

    const key = {
      organizationId: org.id,
      resource: "skill" as const,
      scope: skill.id,
    };
    expect((await ResourcePermissionPolicyModel.find(key))?.grants).toEqual(
      expect.arrayContaining([
        {
          subject: { type: "user", id: writer.id },
          actions: ["read", "update", "use"],
        },
      ]),
    );
    await expect(
      ResourcePermissions.require({
        ...key,
        userId: writer.id,
        action: "update",
      }),
    ).resolves.toBeUndefined();
    await expect(
      ResourcePermissions.require({
        ...key,
        userId: writer.id,
        action: "delete",
      }),
    ).rejects.toThrow("permission");
  });
});

async function runMigration() {
  await runScopedResourcePermissionCutover();
}
