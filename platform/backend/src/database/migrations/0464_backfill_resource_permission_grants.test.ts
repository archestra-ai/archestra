// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db from "@/database";
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
import TeamModel from "@/models/team";
import { checkModelTeamAccess } from "@/routes/proxy/utils/model-team-access";
import { ResourcePermissions } from "@/services/resource-permissions";
import { describe, expect, test } from "@/test";

const migration = fs.readFileSync(
  path.join(__dirname, "0464_colorful_violations.sql"),
  "utf8",
);

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
        isSkillAdmin: false,
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
        isSkillAdmin: false,
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

  test("the complete migration upgrades the previous policy schema and rolls back grants on transaction failure", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
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
    const before = await ResourcePermissionPolicyModel.find(key);
    const failure = new Error("Simulated failure after backfill");
    await expect(
      db.transaction(async (tx) => {
        // Reconstruct 0463's policy schema inside the isolated test database.
        // The transaction also restores this column when the failure rolls back.
        await tx.execute(
          sql`ALTER TABLE resource_permission_policies DROP COLUMN legacy_sharing_migrated`,
        );
        for (const statement of migration.split("--> statement-breakpoint")) {
          await tx.execute(sql.raw(statement));
        }
        const migrated = await tx.execute(sql`
          SELECT grants, legacy_sharing_migrated FROM resource_permission_policies
          WHERE organization_id = ${org.id} AND resource = 'agent' AND scope = ${agent.id}
        `);
        expect(migrated.rows).toEqual([
          {
            grants: [
              {
                subject: { type: "organization", id: "*" },
                actions: ["read", "use"],
              },
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
    await runMigration();
    const publicPolicy = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource: "agent",
      scope: publicAgent.id,
    });
    expect(publicPolicy?.grants).toEqual([
      { subject: { type: "organization", id: "*" }, actions: ["read", "use"] },
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
      userTeamIds: [],
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
  test("composed role scopes do not mix, and team-scoped editing ends when membership is removed", async ({
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
    ).rejects.toThrow("permission");
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
        isAdmin: false,
      }),
    ).toBe(false);
    expect(
      await InternalMcpCatalogModel.findAll({ ...context, isAdmin: false }),
    ).toEqual([]);
    expect(
      await SkillTeamModel.userHasSkillAccess({
        ...context,
        skill,
        isSkillAdmin: false,
        action: "use",
      }),
    ).toBe(false);
    expect(await SkillTeamModel.getUserAccessibleSkillIds(context)).toEqual([]);
    expect(
      await AppAccessModel.userHasAppAccess({
        ...context,
        app,
        isAppAdmin: false,
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
        {
          subject: { type: "serviceAccount", id: account.id },
          actions: ["use"],
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
        principalTeamIds: [team.id],
        userId: user.id,
        grantContext: {
          organizationId: organization.id,
          userId: user.id,
          action: "use",
        },
      }),
    ).toEqual(new Set());
    expect(
      await checkModelTeamAccess({
        provider: "openai",
        modelId: model.modelId,
        organizationId: organization.id,
        authenticatedUserId: user.id,
        userTeamIds: [team.id],
      }),
    ).toMatchObject({ allowed: false });
  });
});

async function runMigration() {
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.includes("WITH ")) await db.execute(sql.raw(statement));
  }
}
